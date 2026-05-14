import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

export type Disposition = "extract" | "append" | "fleeting" | "journal";

export interface LedgerEntry {
  hash: string;
  /** Daily note relPath the block came from (recorded before archiving). */
  source: string;
  disposition: Disposition;
  /** Where the content went. "-" for fleeting (the shared collector). */
  destination: string;
  when: string; // ISO timestamp
}

const HEADER =
  "# Harvest Ledger\n\n" +
  "Append-only record of every daily-note block vault-sidekick has evaluated. " +
  "Used for idempotency (already-seen blocks are skipped on re-runs) and as a " +
  "browsable index of where harvested content went.\n\n" +
  "| hash | source | disposition | destination | when |\n" +
  "|------|--------|-------------|-------------|------|\n";

const ROW_RE =
  /^\|\s*([0-9a-f]{8,})\s*\|\s*(.+?)\s*\|\s*(extract|append|fleeting|journal)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/;

/** Stable hash of a block's text (whitespace-normalized). Matches embedder's 16-hex convention. */
export function hashBlock(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Render a vault path as a clickable Obsidian wikilink (stem only, no alias). */
export function toLink(path: string): string {
  const stem = (path.split("/").pop() ?? path).replace(/\.md$/, "");
  return `[[${stem}]]`;
}

export async function readLedger(filePath: string): Promise<LedgerEntry[]> {
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, "utf-8");
  const entries: LedgerEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(ROW_RE);
    if (m && m[1] && m[2] && m[3] && m[4] && m[5]) {
      entries.push({
        hash: m[1],
        source: m[2],
        disposition: m[3] as Disposition,
        destination: m[4],
        when: m[5],
      });
    }
  }
  return entries;
}

export async function loadSeenHashes(filePath: string): Promise<Set<string>> {
  const entries = await readLedger(filePath);
  return new Set(entries.map((e) => e.hash));
}

export async function appendLedgerEntries(
  filePath: string,
  entries: LedgerEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(dirname(filePath), { recursive: true });
  let existing: string;
  if (existsSync(filePath)) {
    existing = await readFile(filePath, "utf-8");
    if (!existing.endsWith("\n")) existing += "\n";
  } else {
    existing = HEADER;
  }
  const rows = entries
    .map(
      (e) =>
        `| ${e.hash} | ${sanitizeCell(toLink(e.source))} | ${e.disposition} | ${sanitizeCell(toLink(e.destination))} | ${e.when} |`,
    )
    .join("\n");
  await writeFile(filePath, existing + rows + "\n", "utf-8");
}

/** Pipes break markdown table cells; the rare note path containing one gets it swapped. */
function sanitizeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
