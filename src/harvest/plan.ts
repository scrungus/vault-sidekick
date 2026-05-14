import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ResolvedBlock } from "./resolve.js";

/**
 * A harvest plan is the full per-block detail for one daily note. It lives in a
 * sidecar JSON file (referenced by a HARVEST proposal) so proposals.md stays
 * lean — embedding hundreds of full daily-note bodies inline would bloat it.
 */
export interface HarvestPlan {
  daily: string;
  archive_to: string;
  blocks: ResolvedBlock[];
}

export async function writeHarvestPlan(absPath: string, plan: HarvestPlan): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, JSON.stringify(plan, null, 2), "utf-8");
}

export async function readHarvestPlan(absPath: string): Promise<HarvestPlan> {
  const raw = await readFile(absPath, "utf-8");
  const parsed = JSON.parse(raw) as HarvestPlan;
  if (!parsed.daily || !parsed.archive_to || !Array.isArray(parsed.blocks)) {
    throw new Error(`malformed harvest plan: ${absPath}`);
  }
  return parsed;
}

/** Human-readable one-liner for the proposal body. */
export function summarizePlan(plan: HarvestPlan): string {
  const counts = { extract: 0, append: 0, fleeting: 0, journal: 0 };
  for (const b of plan.blocks) counts[b.disposition]++;
  return `${counts.extract} extract · ${counts.append} append · ${counts.fleeting} fleeting · ${counts.journal} journal`;
}
