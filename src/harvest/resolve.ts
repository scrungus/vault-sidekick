import type { EmbeddingStore } from "../embeddings/loader.js";
import { findNearChunks } from "../embeddings/loader.js";
import type { NoteIndex } from "../vault/scanner.js";
import { askClaudeJson } from "../llm/headless.js";
import type { ClassifiedBlock } from "./classify.js";
import { resolveHub, type HubRegistry } from "./hubs.js";

export type ResolvedDisposition = "extract" | "append" | "fleeting" | "journal";

export interface ResolvedBlock {
  hash: string;
  text: string;
  disposition: ResolvedDisposition;
  /**
   * extract  → proposed new note path
   * append   → target existing note path
   * journal  → target hub path or monthly journal path
   * fleeting → undefined (goes to the shared collector)
   */
  destination?: string;
  reason: string;
}

export interface ResolveOptions {
  blocks: ClassifiedBlock[];
  index: NoteIndex;
  store: EmbeddingStore;
  hubRegistry: HubRegistry;
  embed: (texts: string[]) => Promise<number[][]>;
  journalDir: string;
  /** Vault-relative path to the shared fleeting collector. */
  fleetingFile: string;
  /** YYYY-MM-DD of the source daily note, for monthly-journal routing. */
  dailyDate: string;
  /** The daily note being harvested — must never be an append target. */
  sourceDailyPath: string;
  /** Archive dir — notes already here are not valid append targets. */
  archiveDir: string;
}

const DAILY_NOTE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/** A note is a valid append/extract candidate only if it's a real permanent note. */
function isValidTarget(path: string, opts: ResolveOptions): boolean {
  if (path === opts.sourceDailyPath) return false;
  if (path.startsWith(`${opts.archiveDir}/`)) return false;
  const base = path.split("/").pop() ?? "";
  if (DAILY_NOTE_RE.test(base)) return false; // any daily note — it'll be harvested too
  return true;
}

interface ResolveLlmResponse {
  decisions: Array<{
    id: number;
    action: "append" | "extract";
    target?: string;
    new_title?: string;
    reason: string;
  }>;
}

function sanitizeTitle(raw: string): string {
  return raw
    .replace(/[\/\\:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[-\s]+$/, "");
}

export async function resolveBlocks(opts: ResolveOptions): Promise<ResolvedBlock[]> {
  const resolved: ResolvedBlock[] = [];
  const monthlyJournal = `${opts.journalDir}/${opts.dailyDate.slice(0, 7)}.md`;

  interface Pending {
    id: number;
    block: ClassifiedBlock;
    candidates: Array<{ path: string; title: string; excerpt: string }>;
  }
  const pending: Pending[] = [];

  // Pass 1: journal + fleeting resolve locally; extract/append queue for the LLM.
  for (const block of opts.blocks) {
    if (block.disposition === "fleeting") {
      resolved.push({
        hash: block.hash,
        text: block.text,
        disposition: "fleeting",
        destination: opts.fleetingFile,
        reason: block.reason,
      });
      continue;
    }
    if (block.disposition === "journal") {
      const hub = block.genre ? resolveHub(opts.hubRegistry, block.genre) : null;
      resolved.push({
        hash: block.hash,
        text: block.text,
        disposition: "journal",
        destination: hub ?? monthlyJournal,
        reason: hub
          ? `genre "${block.genre}" → hub note`
          : `genre "${block.genre ?? "unspecified"}" → monthly journal`,
      });
      continue;
    }
    pending.push({ id: pending.length, block, candidates: [] });
  }

  if (pending.length === 0) return resolved;

  // Pass 2: embed each pending block, vector-search candidate notes.
  const embeddings = await opts.embed(pending.map((p) => p.block.text));
  for (let i = 0; i < pending.length; i++) {
    const emb = embeddings[i];
    if (!emb) continue;
    const hits = await findNearChunks(opts.store, emb, { limit: 6, minSimilarity: 0.3 });
    const seen = new Set<string>();
    for (const h of hits) {
      if (seen.has(h.source_path)) continue;
      if (!opts.index.notes.has(h.source_path)) continue; // skip stale embeddings
      if (!isValidTarget(h.source_path, opts)) continue; // no dailies/archived/self
      seen.add(h.source_path);
      pending[i]!.candidates.push({
        path: h.source_path,
        title: opts.index.notes.get(h.source_path)?.title ?? h.title,
        excerpt: h.content.slice(0, 300),
      });
      if (seen.size >= 5) break;
    }
  }

  // Pass 3: one batched Claude call resolves append-target vs extract-new for all.
  const prompt = `For each block, decide whether it belongs INSIDE one of its candidate notes (APPEND) or deserves its own new note (EXTRACT).

Append only when the block genuinely extends a candidate's topic. When in doubt, prefer EXTRACT — a slightly redundant new note beats content buried in the wrong place.

Blocks:
${JSON.stringify(
  pending.map((p) => ({
    id: p.id,
    block: p.block.text,
    candidates: p.candidates,
  })),
  null,
  2,
)}

For each: id, action ("append"|"extract"), target (candidate path — required if append), new_title (proposed note title — required if extract), reason (≤ 15 words).

Output shape: {"decisions": [{"id": ..., "action": ..., "target": ..., "new_title": ..., "reason": ...}]}`;

  let decisions: ResolveLlmResponse["decisions"] = [];
  try {
    const res = await askClaudeJson<ResolveLlmResponse>(prompt);
    decisions = res.decisions ?? [];
  } catch (err) {
    console.warn(`[harvest] resolve LLM call failed: ${(err as Error).message}`);
  }

  for (const p of pending) {
    const d = decisions.find((x) => x.id === p.id);
    if (d && d.action === "append" && d.target && opts.index.notes.has(d.target)) {
      resolved.push({
        hash: p.block.hash,
        text: p.block.text,
        disposition: "append",
        destination: d.target,
        reason: d.reason || "extends an existing note",
      });
    } else {
      // EXTRACT — Claude said so, or the append target was missing/invalid.
      const title = sanitizeTitle(d?.new_title || p.block.text.slice(0, 60)) || "Untitled harvest";
      resolved.push({
        hash: p.block.hash,
        text: p.block.text,
        disposition: "extract",
        destination: `${title}.md`,
        reason: d?.reason || "no strong candidate — new note",
      });
    }
  }

  return resolved;
}
