import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { NoteIndex } from "../vault/scanner.js";

/**
 * Embedder for notes that exist in the vault but are absent from
 * vault-context's embedding cache. We mirror vault-context's chunker,
 * file naming, and JSON schema so the produced files are drop-in
 * compatible with vault-context's index.
 */

interface VaultContextCredentials {
  apiKey: string;
  baseUrl: string;
  model: string;
}

async function readVaultContextCredentials(
  vaultPath: string,
): Promise<VaultContextCredentials | null> {
  const dataJsonPath = join(vaultPath, ".obsidian/plugins/vault-context/data.json");
  if (!existsSync(dataJsonPath)) {
    if (!process.env.OPENAI_API_KEY) return null;
    return {
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
    };
  }
  try {
    const raw = await readFile(dataJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { settings?: Record<string, string> };
    const s = parsed.settings ?? {};
    const apiKey = s.embeddingApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    return {
      apiKey,
      baseUrl: s.embeddingBaseUrl || "https://api.openai.com/v1",
      model: s.embeddingModel || "text-embedding-3-small",
    };
  } catch {
    return null;
  }
}

// Mirrors vault-context's SemanticChunker
const MAX_CHUNK_CHARS = 1600; // 400 tokens × 4 chars/token
const OVERLAP_CHARS = 200; // 50 tokens × 4 chars/token

function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end < 0) return md;
  return md.slice(end + 4).replace(/^\s+/, "");
}

function splitOnHeadings(text: string): string[] {
  const lines = text.split("\n");
  const sections: string[] = [];
  let buffer: string[] = [];
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line)) {
      if (buffer.length > 0) sections.push(buffer.join("\n"));
      buffer = [line];
    } else {
      buffer.push(line);
    }
  }
  if (buffer.length > 0) sections.push(buffer.join("\n"));
  return sections.filter((s) => s.trim().length > 0);
}

function chunkSection(section: string): string[] {
  if (section.length <= MAX_CHUNK_CHARS) return [section];
  const paragraphs = section.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current.length === 0) {
      current = p;
    } else if (current.length + 2 + p.length <= MAX_CHUNK_CHARS) {
      current += "\n\n" + p;
    } else {
      chunks.push(current);
      if (p.length <= MAX_CHUNK_CHARS) {
        current = p;
      } else {
        const step = MAX_CHUNK_CHARS - OVERLAP_CHARS;
        for (let i = 0; i < p.length; i += step) {
          chunks.push(p.slice(i, i + MAX_CHUNK_CHARS));
        }
        current = "";
      }
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function chunkMarkdown(md: string): string[] {
  const stripped = stripFrontmatter(md);
  const sections = splitOnHeadings(stripped);
  const out: string[] = [];
  for (const sec of sections) {
    for (const c of chunkSection(sec)) {
      const t = c.trim();
      if (t.length > 0) out.push(t);
    }
  }
  return out;
}

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

async function embedBatch(
  creds: VaultContextCredentials,
  inputs: string[],
): Promise<number[][]> {
  const url = `${creds.baseUrl.replace(/\/$/, "")}/embeddings`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.apiKey}`,
    },
    body: JSON.stringify({ model: creds.model, input: inputs }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embeddings API ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = (await res.json()) as EmbeddingResponse;
  // OpenAI returns in input order; double-check by sorting by index
  const sorted = json.data.slice().sort((a, b) => a.index - b.index);
  return sorted.map((d) => d.embedding);
}

export interface EmbedResult {
  notesProcessed: number;
  chunksEmbedded: number;
  skipped: number;
  skippedReason?: string;
  skippedPaths?: Array<{ path: string; reason: string }>;
}

/**
 * Returns an embed function bound to vault-context's configured credentials,
 * or null if no key is available. Used for ad-hoc embedding (e.g. harvesting
 * individual daily-note blocks for candidate-note search).
 */
export async function createEmbedder(
  vaultPath: string,
): Promise<((texts: string[]) => Promise<number[][]>) | null> {
  const creds = await readVaultContextCredentials(vaultPath);
  if (!creds) return null;
  return (texts: string[]) => embedBatch(creds, texts);
}

export async function refreshMissingEmbeddings(opts: {
  vaultPath: string;
  embeddingsDir: string;
  missingPaths: string[];
  index: NoteIndex;
  /** Max chunks per OpenAI request. Default 64 (well within rate limits). */
  batchSize?: number;
}): Promise<EmbedResult> {
  const skippedPaths: Array<{ path: string; reason: string }> = [];
  const result: EmbedResult = {
    notesProcessed: 0,
    chunksEmbedded: 0,
    skipped: 0,
    skippedPaths,
  };
  if (opts.missingPaths.length === 0) return result;

  const creds = await readVaultContextCredentials(opts.vaultPath);
  if (!creds) {
    result.skipped = opts.missingPaths.length;
    result.skippedReason =
      "no embedding API key found (set OPENAI_API_KEY or configure vault-context)";
    return result;
  }

  await mkdir(opts.embeddingsDir, { recursive: true });
  const batchSize = opts.batchSize ?? 64;

  for (const relPath of opts.missingPaths) {
    const note = opts.index.notes.get(relPath);
    if (!note) {
      result.skipped++;
      skippedPaths.push({ path: relPath, reason: "not in scanner index" });
      continue;
    }
    const content = await readFile(note.absPath, "utf-8");
    const chunks = chunkMarkdown(content);
    if (chunks.length === 0) {
      result.skipped++;
      skippedPaths.push({ path: relPath, reason: "no content after frontmatter strip + chunking" });
      continue;
    }

    const embeddings: number[][] = [];
    for (let i = 0; i < chunks.length; i += batchSize) {
      const slice = chunks.slice(i, i + batchSize);
      const vecs = await embedBatch(creds, slice);
      embeddings.push(...vecs);
    }

    const doc = {
      path: relPath,
      hash: hashContent(content),
      title: note.title,
      outgoing_links: opts.index.outgoing.get(relPath) ?? [],
      backlinks: opts.index.backlinks.get(relPath) ?? [],
      tags: note.tags,
      chunks: chunks.map((c, i) => ({
        index: i,
        content: c,
        embedding: embeddings[i],
      })),
    };

    const fileName = encodeURIComponent(relPath) + ".json";
    await writeFile(join(opts.embeddingsDir, fileName), JSON.stringify(doc), "utf-8");
    result.notesProcessed++;
    result.chunksEmbedded += chunks.length;
  }

  return result;
}
