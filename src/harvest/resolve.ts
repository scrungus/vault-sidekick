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
    action: "append" | "extract" | "fleeting";
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

  // Pass 1: journal resolves locally (hub vs monthly). Everything else —
  // extract, append AND fleeting — goes through the resolver so the LLM makes
  // the final call WITH knowledge of what notes exist. The classifier's
  // disposition is only a hint; a "fleeting" pointer that clearly belongs in
  // an existing resource note should append there, not languish.
  for (const block of opts.blocks) {
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

  // Pass 3: one batched Claude call makes the final placement call for each block.
  const prompt = `For each block, decide where it belongs. A classifier already gave a "suggested" disposition — treat it as a hint, but you can see the candidate notes it couldn't, so you make the final call.

- **append** — the block extends one of its candidate notes. Pick the target path.
- **extract** — the block is a developed idea that deserves its own note. Give a title.
- **fleeting** — the block is too thin to stand alone AND none of the candidates is a genuine home. It goes to a shared review collector.

Prefer **append** whenever there's a real topical match — even a short one-line pointer should append to an existing resource/topic note rather than languish as fleeting. Only choose **fleeting** when there's genuinely no good home. Prefer **extract** over a weak append — a slightly redundant new note beats content buried in the wrong place.

Blocks:
${JSON.stringify(
  pending.map((p) => ({
    id: p.id,
    suggested: p.block.disposition,
    block: p.block.text,
    candidates: p.candidates,
  })),
  null,
  2,
)}

For each: id, action ("append"|"extract"|"fleeting"), target (candidate path — required if append), new_title (proposed note title — required if extract), reason (≤ 15 words).

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
    } else if (d && d.action === "fleeting") {
      resolved.push({
        hash: p.block.hash,
        text: p.block.text,
        disposition: "fleeting",
        destination: opts.fleetingFile,
        reason: d.reason || "too thin, no good home",
      });
    } else if (d && d.action === "extract") {
      const title = sanitizeTitle(d.new_title || p.block.text.slice(0, 60)) || "Untitled harvest";
      resolved.push({
        hash: p.block.hash,
        text: p.block.text,
        disposition: "extract",
        destination: `${title}.md`,
        reason: d.reason || "developed idea — new note",
      });
    } else {
      // No usable decision — fall back to the classifier's original intent.
      const fallbackFleeting = p.block.disposition === "fleeting";
      const title = sanitizeTitle(p.block.text.slice(0, 60)) || "Untitled harvest";
      resolved.push({
        hash: p.block.hash,
        text: p.block.text,
        disposition: fallbackFleeting ? "fleeting" : "extract",
        destination: fallbackFleeting ? opts.fleetingFile : `${title}.md`,
        reason: "resolver gave no decision — fell back to classifier intent",
      });
    }
  }

  return resolved;
}
