import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { scanVault, type NoteIndex } from "../vault/scanner.js";
import {
  findNearChunks,
  loadEmbeddings,
  type ChunkRecord,
  type EmbeddingStore,
} from "../embeddings/loader.js";

type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

interface Insight {
  sourcePath: string;
  sourceTitle: string;
  sourceExcerpt: string;
  neighbourPath: string;
  neighbourTitle: string;
  neighbourExcerpt: string;
  similarity: number;
  graphDistance: number; // Infinity if unreachable
  surpriseScore: number;
  confidence: Confidence;
}

function buildUndirectedAdjacency(index: NoteIndex): Map<string, Set<string>> {
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

function bfs(
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

function classifyConfidence(similarity: number, graphDistance: number): Confidence {
  if (similarity >= 0.85 && graphDistance >= 4) return "EXTRACTED";
  if (similarity >= 0.75) return "INFERRED";
  return "AMBIGUOUS";
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + "…";
}

function obsidianLink(path: string): string {
  // Strip .md extension and use the stem (Obsidian's default wikilink resolution).
  const stem = path.replace(/\.md$/, "").split("/").pop() ?? path;
  return `[[${stem}]]`;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

/**
 * Length of "informative" text in a chunk. Readwise-imported notes contain
 * templated structure (cover image + `## Metadata` section) that is nearly
 * identical across unrelated notes; embedding similarity over those regions
 * is meaningless. We strip that boilerplate before measuring.
 */
function informativeLength(text: string): number {
  return strippedContent(text).length;
}

function strippedContent(text: string): string {
  return text
    .replace(/^##\s+Metadata\b[\s\S]*?(?=\n##\s|$)/gim, "") // Readwise metadata block
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // image embeds
    .replace(/\[[^\]]*\]\([^)]*\)/g, "") // markdown links
    .replace(/https?:\/\/\S+/g, "") // bare URLs
    .replace(/\s+/g, " ")
    .trim();
}

const MIN_INFORMATIVE_CHARS = 120;

function pickRepresentativeChunk(
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

export async function runInsights(cfg: Config): Promise<void> {
  const startedAt = new Date();
  console.log(`[insights] scanning vault at ${cfg.vault.path} ...`);
  const index = await scanVault({
    vaultPath: cfg.vault.path,
    ignoredFolders: cfg.vault.ignored_folders,
  });
  console.log(`[insights] scanned ${index.notes.size} notes`);

  const store = await loadEmbeddings({
    embeddingsDir: cfg.vault.embeddings_dir!,
    knownPaths: index.notes.keys(),
  });
  console.log(
    `[insights] loaded ${store.numNotes} embedded notes / ${store.numChunks} chunks`,
  );

  const adj = buildUndirectedAdjacency(index);
  const adjMaxDepth = Math.max(cfg.insights.min_graph_distance + 3, 6);

  const insightsByPair = new Map<string, Insight>();
  let queriesRun = 0;

  for (const note of index.notes.values()) {
    const rep = pickRepresentativeChunk(note.relPath, store.chunks);
    if (!rep) continue; // not yet embedded
    const distances = bfs(note.relPath, adj, adjMaxDepth);
    const hits = await findNearChunks(store, rep.embedding, {
      limit: cfg.insights.top_k,
      minSimilarity: cfg.insights.min_similarity,
      excludeSourcePath: note.relPath,
    });
    queriesRun++;

    const seenDest = new Set<string>();
    for (const hit of hits) {
      if (seenDest.has(hit.source_path)) continue;
      seenDest.add(hit.source_path);
      // Skip same-folder dailies (mostly noise from journaling style).
      const distance = distances.get(hit.source_path) ?? Infinity;
      if (distance < cfg.insights.min_graph_distance) continue;
      const distanceForScore = distance === Infinity ? adjMaxDepth + 1 : distance;
      const surpriseScore = hit.score * distanceForScore;
      const confidence = classifyConfidence(hit.score, distance);

      const neighbourNote = index.notes.get(hit.source_path);
      const key = pairKey(note.relPath, hit.source_path);
      const existing = insightsByPair.get(key);
      if (existing && existing.surpriseScore >= surpriseScore) continue;

      insightsByPair.set(key, {
        sourcePath: note.relPath,
        sourceTitle: note.title,
        sourceExcerpt: truncate(rep.content, 240),
        neighbourPath: hit.source_path,
        neighbourTitle: neighbourNote?.title ?? hit.title,
        neighbourExcerpt: truncate(hit.content, 240),
        similarity: hit.score,
        graphDistance: distance,
        surpriseScore,
        confidence,
      });
    }
  }

  const insights = [...insightsByPair.values()].sort(
    (a, b) => b.surpriseScore - a.surpriseScore,
  );
  const capped = insights.slice(0, cfg.insights.max_per_report);

  console.log(
    `[insights] ran ${queriesRun} vector queries; found ${insights.length} candidate pairs, keeping top ${capped.length}`,
  );

  const report = renderReport(capped, {
    generatedAt: startedAt,
    totalNotes: index.notes.size,
    queriesRun,
    candidatePairs: insights.length,
    config: cfg,
    store,
  });

  await mkdir(cfg.inbox.dir, { recursive: true });
  const dateStamp = startedAt.toISOString().slice(0, 10);
  const outPath = join(cfg.inbox.dir, `daily-insights-${dateStamp}.md`);
  await writeFile(outPath, report, "utf-8");
  console.log(`[insights] wrote ${outPath}`);
}

function renderReport(
  insights: Insight[],
  ctx: {
    generatedAt: Date;
    totalNotes: number;
    queriesRun: number;
    candidatePairs: number;
    config: Config;
    store: EmbeddingStore;
  },
): string {
  const lines: string[] = [];
  const iso = ctx.generatedAt.toISOString();
  lines.push(`# Daily Insights — ${iso.slice(0, 10)}`);
  lines.push("");
  lines.push(`> Generated by vault-sidekick at ${iso}.`);
  lines.push(
    `> Scanned ${ctx.totalNotes} notes · ${ctx.store.numChunks} chunks across ${ctx.store.numNotes} embedded notes · ran ${ctx.queriesRun} vector queries.`,
  );
  if (ctx.store.missingPaths.length > 0) {
    lines.push(
      `> ${ctx.store.missingPaths.length} notes have no embedding yet (open Obsidian to refresh).`,
    );
  }
  lines.push("");
  lines.push("## Surprising connections");
  lines.push("");
  lines.push(
    "Pairs that are semantically close but distant in your link graph. Consider whether they should be linked.",
  );
  lines.push("");
  lines.push(
    "Confidence tags: **EXTRACTED** = strong signal · **INFERRED** = worth a look · **AMBIGUOUS** = borderline.",
  );
  lines.push("");

  if (insights.length === 0) {
    lines.push("_No surprising connections above thresholds. Adjust `insights.min_similarity` or `insights.min_graph_distance` in your config to widen the net._");
    lines.push("");
    return lines.join("\n");
  }

  for (let i = 0; i < insights.length; i++) {
    const x = insights[i]!;
    const distLabel = x.graphDistance === Infinity ? "no path" : `${x.graphDistance} hops`;
    lines.push(
      `### ${i + 1}. ${obsidianLink(x.sourcePath)} ↔ ${obsidianLink(x.neighbourPath)}`,
    );
    lines.push("");
    lines.push(
      `**sim** ${x.similarity.toFixed(3)} · **graph** ${distLabel} · **${x.confidence}**`,
    );
    lines.push("");
    lines.push(`> from \`${x.sourcePath}\`: ${x.sourceExcerpt}`);
    lines.push("");
    lines.push(`> from \`${x.neighbourPath}\`: ${x.neighbourExcerpt}`);
    lines.push("");
  }

  return lines.join("\n");
}
