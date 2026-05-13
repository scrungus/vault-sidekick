import type { NoteIndex } from "../vault/scanner.js";
import {
  findNearChunks,
  type ChunkRecord,
  type EmbeddingStore,
} from "../embeddings/loader.js";
import type { Confidence } from "../proposals/types.js";

export interface InsightPair {
  sourcePath: string;
  sourceTitle: string;
  sourceExcerpt: string;
  neighbourPath: string;
  neighbourTitle: string;
  neighbourExcerpt: string;
  similarity: number;
  graphDistance: number;
  surpriseScore: number;
  confidence: Confidence;
}

export interface PairOptions {
  topK: number;
  minSimilarity: number;
  minGraphDistance: number;
}

const MIN_INFORMATIVE_CHARS = 120;

export function informativeLength(text: string): number {
  return text
    .replace(/^##\s+Metadata\b[\s\S]*?(?=\n##\s|$)/gim, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim().length;
}

export function pickRepresentativeChunk(
  sourcePath: string,
  chunks: readonly ChunkRecord[],
): ChunkRecord | null {
  let best: { chunk: ChunkRecord; score: number } | null = null;
  for (const c of chunks) {
    if (c.source_path !== sourcePath) continue;
    const score = informativeLength(c.content);
    if (score < MIN_INFORMATIVE_CHARS) continue;
    if (!best || score > best.score) best = { chunk: c, score };
  }
  return best?.chunk ?? null;
}

export function buildUndirectedAdjacency(index: NoteIndex): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const [src, outs] of index.outgoing) {
    for (const dst of outs) {
      if (!adj.has(src)) adj.set(src, new Set());
      if (!adj.has(dst)) adj.set(dst, new Set());
      adj.get(src)!.add(dst);
      adj.get(dst)!.add(src);
    }
  }
  return adj;
}

export function bfs(
  start: string,
  adj: Map<string, Set<string>>,
  maxDepth: number,
): Map<string, number> {
  const dist = new Map<string, number>();
  dist.set(start, 0);
  let frontier: string[] = [start];
  for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      const neighbours = adj.get(node);
      if (!neighbours) continue;
      for (const n of neighbours) {
        if (!dist.has(n)) {
          dist.set(n, d);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + "…";
}

function classifyConfidence(similarity: number, graphDistance: number): Confidence {
  if (similarity >= 0.85 && graphDistance >= 4) return "EXTRACTED";
  if (similarity >= 0.75) return "INFERRED";
  return "AMBIGUOUS";
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

export interface PairComputation {
  pairs: InsightPair[];
  queriesRun: number;
}

/**
 * For each source note pick its most informative chunk, query embedding-neighbours,
 * filter by graph distance, dedupe by canonical pair key, return ranked pairs.
 */
export async function findInsightPairs(
  index: NoteIndex,
  store: EmbeddingStore,
  opts: PairOptions,
): Promise<PairComputation> {
  const adj = buildUndirectedAdjacency(index);
  const adjMaxDepth = Math.max(opts.minGraphDistance + 3, 6);

  const byPair = new Map<string, InsightPair>();
  let queriesRun = 0;

  for (const note of index.notes.values()) {
    const rep = pickRepresentativeChunk(note.relPath, store.chunks);
    if (!rep) continue;
    const distances = bfs(note.relPath, adj, adjMaxDepth);
    const hits = await findNearChunks(store, rep.embedding, {
      limit: opts.topK,
      minSimilarity: opts.minSimilarity,
      excludeSourcePath: note.relPath,
    });
    queriesRun++;

    const seenDest = new Set<string>();
    for (const hit of hits) {
      if (seenDest.has(hit.source_path)) continue;
      seenDest.add(hit.source_path);
      // Skip stale embeddings: vault-context may still hold JSON files for
      // notes that have been deleted on disk.
      if (!index.notes.has(hit.source_path)) continue;
      const distance = distances.get(hit.source_path) ?? Infinity;
      if (distance < opts.minGraphDistance) continue;
      const distForScore = distance === Infinity ? adjMaxDepth + 1 : distance;
      const surpriseScore = hit.score * distForScore;
      const confidence = classifyConfidence(hit.score, distance);
      const neighbour = index.notes.get(hit.source_path);
      const key = pairKey(note.relPath, hit.source_path);
      const existing = byPair.get(key);
      if (existing && existing.surpriseScore >= surpriseScore) continue;
      byPair.set(key, {
        sourcePath: note.relPath,
        sourceTitle: note.title,
        sourceExcerpt: truncate(rep.content, 240),
        neighbourPath: hit.source_path,
        neighbourTitle: neighbour?.title ?? hit.title,
        neighbourExcerpt: truncate(hit.content, 240),
        similarity: hit.score,
        graphDistance: distance,
        surpriseScore,
        confidence,
      });
    }
  }

  const pairs = [...byPair.values()].sort((a, b) => b.surpriseScore - a.surpriseScore);
  return { pairs, queriesRun };
}
