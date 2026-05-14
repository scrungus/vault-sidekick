import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Config } from "../config.js";
import { scanVault, type NoteIndex } from "../vault/scanner.js";
import { loadEmbeddings, type EmbeddingStore } from "../embeddings/loader.js";
import { createEmbedder } from "../embeddings/embedder.js";
import { buildHubRegistry, type HubRegistry } from "../harvest/hubs.js";
import { hashBlock, loadSeenHashes, toLink } from "../harvest/ledger.js";
import { classifyDailyNote } from "../harvest/classify.js";
import { resolveBlocks } from "../harvest/resolve.js";
import { writeHarvestPlan, summarizePlan, type HarvestPlan } from "../harvest/plan.js";
import {
  appendProposals,
  nextProposalId,
  readProposals,
  updateProposalState,
} from "../proposals/file.js";
import type { NewProposal, Proposal } from "../proposals/types.js";

const DAILY_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

export interface HarvestContext {
  cfg: Config;
  index: NoteIndex;
  store: EmbeddingStore;
  hubRegistry: HubRegistry;
  embed: (texts: string[]) => Promise<number[][]>;
  /** All existing proposals — used for ID allocation and for content-hash
   *  comparison so unchanged dailies aren't re-planned. */
  existingProposals: Proposal[];
}

/** Map of daily path → its current pending (proposed) HARVEST proposal. */
function liveHarvestProposals(proposals: Proposal[]): Map<string, Proposal> {
  const live = new Map<string, Proposal>();
  for (const p of proposals) {
    if (p.kind === "HARVEST" && p.action.op === "harvest" && p.state === "proposed") {
      live.set(p.action.daily, p);
    }
  }
  return live;
}

/** Daily notes eligible for harvest: YYYY-MM-DD.md, not archived, older than the cron buffer. */
export function harvestableDailies(cfg: Config, index: NoteIndex): string[] {
  const cutoff = Date.now() - cfg.harvest.cron_buffer_days * 86_400_000;
  const out: string[] = [];
  for (const note of index.notes.values()) {
    const fileName = note.relPath.split("/").pop() ?? "";
    if (!DAILY_RE.test(fileName)) continue;
    if (note.relPath.startsWith(`${cfg.harvest.archive_dir}/`)) continue;
    const dailyTime = Date.parse(fileName.replace(/\.md$/, ""));
    if (!Number.isNaN(dailyTime) && dailyTime > cutoff) continue;
    out.push(note.relPath);
  }
  out.sort(); // oldest first
  return out;
}

/**
 * Plan harvests for up to `maxDailies` eligible daily notes: classify, resolve,
 * write sidecar plans, and return HARVEST proposals (state: proposed). Does NOT
 * write proposals.md — the caller batches that.
 */
export async function planHarvest(
  ctx: HarvestContext,
  maxDailies: number,
): Promise<NewProposal[]> {
  const { cfg, index } = ctx;
  const proposalsFile = join(cfg.inbox.dir, cfg.inbox.proposals_file);
  const live = liveHarvestProposals(ctx.existingProposals);

  // Selection pass: choose which dailies to plan. A daily that already has a
  // pending proposal is re-planned only if its content hash has changed since
  // that proposal was made (i.e. the note was edited).
  const toPlan: Array<{ daily: string; content: string; contentHash: string }> = [];
  const supersede: string[] = [];
  for (const dailyRel of harvestableDailies(cfg, index)) {
    if (toPlan.length >= maxDailies) break;
    const note = index.notes.get(dailyRel);
    if (!note) continue;
    const content = await readFile(note.absPath, "utf-8");
    const contentHash = hashBlock(content);
    const existing = live.get(dailyRel);
    if (existing) {
      const priorHash =
        existing.action.op === "harvest" ? existing.action.content_hash : undefined;
      if (priorHash === contentHash) continue; // unchanged — keep existing proposal
      supersede.push(existing.id); // daily edited since proposed — replace it
    }
    toPlan.push({ daily: dailyRel, content, contentHash });
  }
  if (toPlan.length === 0) return [];

  for (const id of supersede) {
    await updateProposalState(proposalsFile, id, "rejected");
    console.log(`  superseded ${id} (daily changed since it was proposed)`);
  }

  const ledgerAbs = join(cfg.inbox.dir, "harvest-ledger.md");
  const ledgerRel = relative(cfg.vault.path, ledgerAbs);
  const seenHashes = await loadSeenHashes(ledgerAbs);

  const proposals: NewProposal[] = [];
  for (const { daily: dailyRel, content, contentHash } of toPlan) {
    const classification = await classifyDailyNote({
      dailyPath: dailyRel,
      content,
      seenHashes,
    });
    if (classification.blocks.length === 0) {
      console.log(
        `  ${dailyRel}: nothing to harvest (${classification.skippedSeen} already seen)`,
      );
      continue;
    }

    const dailyDate = (dailyRel.split("/").pop() ?? dailyRel).replace(/\.md$/, "");
    const resolved = await resolveBlocks({
      blocks: classification.blocks,
      index,
      store: ctx.store,
      hubRegistry: ctx.hubRegistry,
      embed: ctx.embed,
      journalDir: cfg.harvest.journal_dir,
      fleetingFile: cfg.harvest.fleeting_file,
      dailyDate,
      sourceDailyPath: dailyRel,
      archiveDir: cfg.harvest.archive_dir,
    });

    const plan: HarvestPlan = {
      daily: dailyRel,
      archive_to: `${cfg.harvest.archive_dir}/${dailyDate}.md`,
      blocks: resolved,
    };

    const planAbs = join(cfg.inbox.dir, "harvest-plans", `${dailyDate}.json`);
    const planRel = relative(cfg.vault.path, planAbs);
    await writeHarvestPlan(planAbs, plan);

    const id = nextProposalId(
      [...ctx.existingProposals, ...proposals.map((p) => ({ id: p.id, kind: p.kind }))],
      "HARVEST",
    );
    const destinations = [
      ...new Set(resolved.map((b) => b.destination).filter((d): d is string => !!d)),
    ];
    const routes = destinations.map(toLink).join(" · ");
    proposals.push({
      id,
      kind: "HARVEST",
      title: `harvest ${toLink(dailyRel)} — ${summarizePlan(plan)}`,
      reason: `${resolved.length} block(s) → ${routes || "(fleeting)"}`,
      action: {
        op: "harvest",
        daily: dailyRel,
        archive_to: plan.archive_to,
        plan: planRel,
        ledger: ledgerRel,
        content_hash: contentHash,
      },
      initialState: "proposed",
    });
    console.log(`  ${dailyRel}: ${summarizePlan(plan)}`);
  }
  return proposals;
}

export interface HarvestOptions {
  maxDailies?: number;
  dryRun?: boolean;
}

/** Standalone `vault-sidekick harvest` command. */
export async function runHarvest(cfg: Config, opts: HarvestOptions = {}): Promise<void> {
  const t0 = Date.now();
  console.log(`[harvest] scanning ${cfg.vault.path}`);
  const index = await scanVault({
    vaultPath: cfg.vault.path,
    ignoredFolders: cfg.vault.ignored_folders,
  });

  const embed = await createEmbedder(cfg.vault.path);
  if (!embed) {
    console.error(
      "[harvest] no embedding key found (vault-context data.json / OPENAI_API_KEY). " +
        "extract/append resolution needs it — aborting.",
    );
    return;
  }

  const store = await loadEmbeddings({
    embeddingsDir: cfg.vault.embeddings_dir!,
    knownPaths: index.notes.keys(),
  });
  const hubRegistry = buildHubRegistry(index, cfg.harvest.hub_tag);
  const proposalsFile = join(cfg.inbox.dir, cfg.inbox.proposals_file);
  const existingProposals = await readProposals(proposalsFile);

  const eligible = harvestableDailies(cfg, index);
  const max = opts.maxDailies ?? eligible.length;
  console.log(
    `[harvest] ${eligible.length} eligible dailies · ${hubRegistry.size} hubs · processing up to ${max}`,
  );

  const proposals = await planHarvest(
    {
      cfg,
      index,
      store,
      hubRegistry,
      embed,
      existingProposals,
    },
    max,
  );

  if (proposals.length > 0 && !opts.dryRun) {
    await appendProposals(proposalsFile, proposals);
    console.log(`[harvest] wrote ${proposals.length} HARVEST proposals to ${proposalsFile}`);
  } else if (opts.dryRun) {
    console.log(`[harvest] --dry-run: would have written ${proposals.length} proposals`);
  }

  console.log(`[harvest] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
