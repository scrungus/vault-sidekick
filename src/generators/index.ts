import { readFile } from "node:fs/promises";
import type { NoteIndex } from "../vault/scanner.js";
import type { EmbeddingStore } from "../embeddings/loader.js";
import { findNearChunks } from "../embeddings/loader.js";
import { askClaudeJson } from "../llm/headless.js";
import type {
  Confidence,
  LinkAddAction,
  MergeAction,
  MoveAction,
  ProposalAction,
  ProposalKind,
} from "../proposals/types.js";
import type { InsightPair } from "../analysis/pairs.js";

export interface ProposedAction {
  kind: ProposalKind;
  title: string;
  reason?: string;
  confidence?: Confidence;
  action: ProposalAction;
  /** When true, the run command auto-executes before writing the proposal. */
  autoExec: boolean;
}

export type { InsightPair };

export interface GeneratorContext {
  vaultPath: string;
  index: NoteIndex;
  store: EmbeddingStore;
  paraBuckets: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickInformativeChunk(
  sourcePath: string,
  store: EmbeddingStore,
): { content: string; embedding: number[] } | null {
  let best: { content: string; embedding: number[]; score: number } | null = null;
  for (const c of store.chunks) {
    if (c.source_path !== sourcePath) continue;
    const score = informativeLength(c.content);
    if (score < 80) continue;
    if (!best || score > best.score) {
      best = { content: c.content, embedding: c.embedding, score };
    }
  }
  return best ? { content: best.content, embedding: best.embedding } : null;
}

function informativeLength(text: string): number {
  return text
    .replace(/^##\s+Metadata\b[\s\S]*?(?=\n##\s|$)/gim, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim().length;
}

function stemOf(relPath: string): string {
  return (relPath.split("/").pop() ?? relPath).replace(/\.md$/, "");
}

function topFolderOf(relPath: string): string {
  const idx = relPath.indexOf("/");
  return idx >= 0 ? relPath.slice(0, idx) : "";
}

// ---------------------------------------------------------------------------
// LINK generator (no LLM — heuristic: insights pairs auto-link)
// ---------------------------------------------------------------------------

export function generateLinkProposals(pairs: InsightPair[]): ProposedAction[] {
  const out: ProposedAction[] = [];
  for (const p of pairs) {
    const action: LinkAddAction = {
      op: "link_add",
      in: p.sourcePath,
      target: p.neighbourPath,
    };
    out.push({
      kind: "LINK",
      title: `[[${stemOf(p.sourcePath)}]] → [[${stemOf(p.neighbourPath)}]]`,
      reason: `sim ${p.similarity.toFixed(3)} · graph ${p.graphDistance === Infinity ? "no path" : `${p.graphDistance} hops`}`,
      confidence: p.confidence,
      action,
      autoExec: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// MERGE generator
// ---------------------------------------------------------------------------

interface MergeLlmResponse {
  pairs: Array<{
    id: number;
    merge: boolean;
    reason: string;
    direction?: "A_INTO_B" | "B_INTO_A";
  }>;
}

interface MergeCandidate {
  id: number;
  pathA: string;
  pathB: string;
  similarity: number;
  excerptA: string;
  excerptB: string;
}

export async function generateMergeProposals(
  ctx: GeneratorContext,
  opts: { minSimilarity: number; maxCandidates: number },
): Promise<ProposedAction[]> {
  const candidates = await findMergeCandidates(ctx, opts);
  if (candidates.length === 0) return [];

  const llmDecisions = await askMergeBatch(candidates);
  const proposals: ProposedAction[] = [];

  for (const c of candidates) {
    const decision = llmDecisions.find((d) => d.id === c.id);
    if (!decision || !decision.merge) continue;
    const into = decision.direction === "B_INTO_A" ? c.pathA : c.pathB;
    const from = decision.direction === "B_INTO_A" ? c.pathB : c.pathA;
    const action: MergeAction = { op: "merge", into, from };
    proposals.push({
      kind: "MERGE",
      title: `[[${stemOf(into)}]] ← absorbs [[${stemOf(from)}]]`,
      reason: `sim ${c.similarity.toFixed(3)}. ${decision.reason}`,
      confidence: c.similarity >= 0.98 ? "EXTRACTED" : "INFERRED",
      action,
      autoExec: false,
    });
  }
  return proposals;
}

async function findMergeCandidates(
  ctx: GeneratorContext,
  opts: { minSimilarity: number; maxCandidates: number },
): Promise<MergeCandidate[]> {
  const seenPair = new Set<string>();
  const candidates: MergeCandidate[] = [];

  for (const note of ctx.index.notes.values()) {
    if (candidates.length >= opts.maxCandidates) break;
    const rep = pickInformativeChunk(note.relPath, ctx.store);
    if (!rep) continue;
    const hits = await findNearChunks(ctx.store, rep.embedding, {
      limit: 5,
      minSimilarity: opts.minSimilarity,
      excludeSourcePath: note.relPath,
    });
    const seenDest = new Set<string>();
    for (const h of hits) {
      if (seenDest.has(h.source_path)) continue;
      seenDest.add(h.source_path);
      const key = note.relPath < h.source_path
        ? `${note.relPath}\0${h.source_path}`
        : `${h.source_path}\0${note.relPath}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      candidates.push({
        id: candidates.length,
        pathA: note.relPath,
        pathB: h.source_path,
        similarity: h.score,
        excerptA: rep.content.slice(0, 1200),
        excerptB: h.content.slice(0, 1200),
      });
      if (candidates.length >= opts.maxCandidates) break;
    }
  }
  return candidates;
}

async function askMergeBatch(
  candidates: MergeCandidate[],
): Promise<MergeLlmResponse["pairs"]> {
  // Process in batches of 8 to keep prompts readable
  const all: MergeLlmResponse["pairs"] = [];
  const batchSize = 8;
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const prompt = `You are reviewing pairs of Obsidian notes that look very similar by embedding distance. For each pair, decide whether they are essentially the same content that should be merged. Reject false positives caused by shared templates, similar topic but different specifics, or one being a referenced subset of the other.

For each pair output: id, merge (true/false), reason (≤ 25 words), direction (one of "A_INTO_B" or "B_INTO_A") only when merge=true. Direction chooses which note becomes the target — pick the one with broader scope or more incoming links to preserve.

Pairs:
${JSON.stringify(
  batch.map((c) => ({
    id: c.id,
    A_path: c.pathA,
    B_path: c.pathB,
    similarity: c.similarity,
    A_excerpt: c.excerptA,
    B_excerpt: c.excerptB,
  })),
  null,
  2,
)}

Output shape: {"pairs": [{"id": ..., "merge": ..., "reason": ..., "direction": ...}, ...]}`;

    try {
      const res = await askClaudeJson<MergeLlmResponse>(prompt);
      if (Array.isArray(res.pairs)) all.push(...res.pairs);
    } catch (err) {
      console.warn(`[generators] merge batch failed: ${(err as Error).message}`);
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// PARA generator
// ---------------------------------------------------------------------------

interface ParaLlmResponse {
  notes: Array<{
    id: number;
    bucket: string;
    confidence: number;
    reason: string;
  }>;
}

interface ParaCandidate {
  id: number;
  path: string;
  title: string;
  tags: string[];
  excerpt: string;
}

export async function generateParaProposals(
  ctx: GeneratorContext,
  opts: { batchSize?: number; maxNotes?: number },
): Promise<ProposedAction[]> {
  const batchSize = opts.batchSize ?? 30;
  const maxNotes = opts.maxNotes ?? Infinity;

  const candidates = await collectParaCandidates(ctx, maxNotes);
  if (candidates.length === 0) return [];

  const proposals: ProposedAction[] = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    const decisions = await askParaBatch(batch, ctx.paraBuckets);
    for (const c of batch) {
      const d = decisions.find((x) => x.id === c.id);
      if (!d || !ctx.paraBuckets.includes(d.bucket)) continue;
      if (d.confidence < 0.6) continue;
      const newPath = `${d.bucket}/${c.path}`;
      const action: MoveAction = { op: "move", from: c.path, to: newPath };
      proposals.push({
        kind: "PARA",
        title: `[[${stemOf(c.path)}]] → ${d.bucket}/`,
        reason: `${d.reason} (confidence ${d.confidence.toFixed(2)})`,
        confidence: d.confidence >= 0.85 ? "EXTRACTED" : d.confidence >= 0.7 ? "INFERRED" : "AMBIGUOUS",
        action,
        autoExec: true,
      });
    }
  }
  return proposals;
}

async function collectParaCandidates(
  ctx: GeneratorContext,
  maxNotes: number,
): Promise<ParaCandidate[]> {
  const buckets = new Set(ctx.paraBuckets);
  const candidates: ParaCandidate[] = [];
  let id = 0;
  for (const note of ctx.index.notes.values()) {
    if (candidates.length >= maxNotes) break;
    const top = topFolderOf(note.relPath);
    if (buckets.has(top)) continue; // already classified
    // Skip notes the user almost certainly doesn't want auto-moved
    if (top === "" && /^\d{4}-\d{2}-\d{2}\.md$/.test(note.relPath)) continue; // daily notes
    if (note.relPath.startsWith("Reading/Readwise/")) continue; // Readwise-managed
    if (note.relPath.startsWith("smart-chats/")) continue;
    const content = await readFile(note.absPath, "utf-8");
    const excerpt = informativeLength(content) > 0 ? content.slice(0, 800) : "";
    if (excerpt.length < 30) continue; // skip empty/near-empty
    candidates.push({
      id: id++,
      path: note.relPath,
      title: note.title,
      tags: note.tags,
      excerpt,
    });
  }
  return candidates;
}

async function askParaBatch(
  batch: ParaCandidate[],
  buckets: string[],
): Promise<ParaLlmResponse["notes"]> {
  const prompt = `Classify each note into a PARA bucket. PARA conventions:

- **Projects** — things with a deadline or specific deliverable being actively worked on
- **Areas** — ongoing responsibilities with no end date (health, finances, learning a craft)
- **Resources** — reference material kept for future use (books, articles, knowledge stacks)
- **Archives** — completed projects, inactive material, things kept for record only

If the user uses different bucket names, map to whichever from the allowed list matches best.

Allowed buckets: ${JSON.stringify(buckets)}

For each note output: id, bucket (from allowed list), confidence (0.0-1.0), reason (≤ 20 words). When unsure, lower the confidence rather than guess — anything below 0.6 is ignored.

Notes:
${JSON.stringify(
  batch.map((c) => ({
    id: c.id,
    path: c.path,
    title: c.title,
    tags: c.tags,
    excerpt: c.excerpt,
  })),
  null,
  2,
)}

Output shape: {"notes": [{"id": ..., "bucket": ..., "confidence": ..., "reason": ...}, ...]}`;

  try {
    const res = await askClaudeJson<ParaLlmResponse>(prompt);
    return Array.isArray(res.notes) ? res.notes : [];
  } catch (err) {
    console.warn(`[generators] para batch failed: ${(err as Error).message}`);
    return [];
  }
}
