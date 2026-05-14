import { askClaudeJson } from "../llm/headless.js";
import { hashBlock, type Disposition } from "./ledger.js";

export interface ClassifiedBlock {
  hash: string;
  /** Verbatim block text from the daily note. */
  text: string;
  disposition: Disposition;
  /** For journal blocks only: the genre Claude assigned (e.g. "dreams"). */
  genre?: string;
  reason: string;
}

export interface DailyClassification {
  dailyPath: string;
  blocks: ClassifiedBlock[];
  /** Blocks dropped because their hash was already in the ledger. */
  skippedSeen: number;
}

interface ClassifyLlmResponse {
  blocks: Array<{
    text: string;
    disposition: Disposition;
    genre?: string;
    reason: string;
  }>;
}

function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end < 0) return md;
  return md.slice(end + 4).replace(/^\s+/, "");
}

const VALID_DISPOSITIONS: ReadonlySet<Disposition> = new Set([
  "extract",
  "append",
  "fleeting",
  "journal",
]);

export async function classifyDailyNote(opts: {
  dailyPath: string;
  content: string;
  seenHashes: Set<string>;
}): Promise<DailyClassification> {
  const body = stripFrontmatter(opts.content).trim();
  if (body.length === 0) {
    return { dailyPath: opts.dailyPath, blocks: [], skippedSeen: 0 };
  }

  const prompt = `You are processing a daily journal note from an Obsidian vault. The user never re-reads individual daily notes, so the content needs to be surfaced into permanent notes; the daily note itself gets archived afterward.

Segment the note into blocks, where a block is a self-contained unit of thought. **Err strongly toward larger blocks** — only start a new block when the content genuinely shifts topic, type, or intent. Multiple sentences or paragraphs describing the same dream, story, idea, event, or train of thought are ONE block, never several. When unsure whether to split, don't.

Classify each block:

- **extract** — a developed idea or piece of knowledge that deserves its own permanent note
- **append** — content that belongs inside an existing permanent note on a topic the user likely already has
- **fleeting** — a thin idea-fragment, too slight to be its own note but worth keeping for later review
- **journal** — personal log content: dreams, reflections, mood, daily events. Not knowledge, but still worth surfacing into a journal collection.

For **journal** blocks, also give a lowercase one-word **genre** ("dreams", "reflection", "health", "work-log", etc.). Omit genre for non-journal blocks.

Rules:
- Keep block text VERBATIM. Do not rewrite, summarize, or merge blocks.
- Preserve every piece of content — do not drop anything.
- "reason" is one short clause (≤ 15 words).

Daily note (${opts.dailyPath}):
---
${body}
---

Output shape: {"blocks": [{"text": "...", "disposition": "...", "genre": "...", "reason": "..."}]}`;

  const res = await askClaudeJson<ClassifyLlmResponse>(prompt);
  const blocks: ClassifiedBlock[] = [];
  let skippedSeen = 0;

  for (const b of res.blocks ?? []) {
    if (!b.text || !b.text.trim()) continue;
    if (!VALID_DISPOSITIONS.has(b.disposition)) continue;
    const hash = hashBlock(b.text);
    if (opts.seenHashes.has(hash)) {
      skippedSeen++;
      continue;
    }
    blocks.push({
      hash,
      text: b.text,
      disposition: b.disposition,
      genre:
        b.disposition === "journal" && b.genre ? b.genre.trim().toLowerCase() : undefined,
      reason: b.reason ?? "",
    });
  }

  return { dailyPath: opts.dailyPath, blocks, skippedSeen };
}
