import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExecutorContext, ExecutorResult } from "../executors/types.js";
import type { HarvestAction } from "../proposals/types.js";
import { readHarvestPlan } from "./plan.js";
import { appendLedgerEntries, type LedgerEntry } from "./ledger.js";

function dailyStemOf(dailyPath: string): string {
  return (dailyPath.split("/").pop() ?? dailyPath).replace(/\.md$/, "");
}

/** Append a block under a dated heading; creates the file (and parent dirs) if absent. */
async function appendUnderHeading(
  absPath: string,
  heading: string,
  body: string,
): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  let existing = "";
  if (existsSync(absPath)) {
    existing = (await readFile(absPath, "utf-8")).replace(/\s*$/, "");
  }
  const sep = existing ? "\n\n" : "";
  await writeFile(absPath, `${existing}${sep}${heading}\n\n${body.trim()}\n`, "utf-8");
}

/** A note that's missing, empty, or frontmatter-only — safe to write an extract into. */
async function isWritableTarget(absPath: string): Promise<boolean> {
  if (!existsSync(absPath)) return true;
  try {
    let body = await readFile(absPath, "utf-8");
    if (body.startsWith("---")) {
      const end = body.indexOf("\n---", 3);
      if (end >= 0) body = body.slice(end + 4);
    }
    return body.trim().length === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve where an extracted note should be written. If the target name is
 * free OR points at an empty placeholder note (Obsidian auto-creates these
 * when you click a not-yet-existing wikilink), use it. Only disambiguate with
 * a numeric suffix when a real, non-empty note already owns the name.
 */
async function resolveExtractPath(vaultPath: string, relPath: string): Promise<string> {
  if (await isWritableTarget(join(vaultPath, relPath))) return relPath;
  const base = relPath.replace(/\.md$/, "");
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} (${i}).md`;
    if (await isWritableTarget(join(vaultPath, candidate))) return candidate;
  }
  return `${base} (${Date.now()}).md`;
}

export async function executeHarvest(
  action: HarvestAction,
  ctx: ExecutorContext,
  propId: string,
): Promise<ExecutorResult> {
  const plan = await readHarvestPlan(join(ctx.vaultPath, action.plan));
  const dailyStem = dailyStemOf(action.daily);
  const now = new Date().toISOString();

  const affected = new Set<string>();
  const ledgerEntries: LedgerEntry[] = [];

  for (const block of plan.blocks) {
    if (block.disposition === "extract") {
      if (!block.destination) continue;
      const rel = await resolveExtractPath(ctx.vaultPath, block.destination);
      const abs = join(ctx.vaultPath, rel);
      await mkdir(dirname(abs), { recursive: true });
      const frontmatter = `---\nsource: "[[${dailyStem}]]"\nharvested: ${now.slice(0, 10)}\n---\n\n`;
      await writeFile(abs, frontmatter + block.text.trim() + "\n", "utf-8");
      affected.add(rel);
      ledgerEntries.push({
        hash: block.hash,
        source: action.daily,
        disposition: "extract",
        destination: rel,
        when: now,
      });
    } else {
      // append / journal / fleeting → append under a dated heading
      if (!block.destination) continue;
      await appendUnderHeading(
        join(ctx.vaultPath, block.destination),
        `## from [[${dailyStem}]]`,
        block.text,
      );
      affected.add(block.destination);
      ledgerEntries.push({
        hash: block.hash,
        source: action.daily,
        disposition: block.disposition,
        destination: block.destination,
        when: now,
      });
    }
  }

  // Archive the daily note itself.
  const dailyAbs = join(ctx.vaultPath, action.daily);
  if (existsSync(dailyAbs)) {
    const archiveAbs = join(ctx.vaultPath, action.archive_to);
    await mkdir(dirname(archiveAbs), { recursive: true });
    await rename(dailyAbs, archiveAbs);
    affected.add(action.daily);
    affected.add(action.archive_to);
  }

  // Record provenance + idempotency.
  await appendLedgerEntries(join(ctx.vaultPath, action.ledger), ledgerEntries);
  affected.add(action.ledger);

  const staged = [...affected];
  const sha = await ctx.git.commitPaths(
    `${propId}: harvest ${action.daily} (${plan.blocks.length} blocks) → archived`,
    staged,
  );
  return { commitSha: sha, filesAffected: staged };
}
