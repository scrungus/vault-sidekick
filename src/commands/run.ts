import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "../config.js";
import { scanVault, type NoteIndex } from "../vault/scanner.js";
import {
  loadEmbeddings,
  type EmbeddingStore,
} from "../embeddings/loader.js";
import { refreshMissingEmbeddings } from "../embeddings/embedder.js";
import { findInsightPairs } from "../analysis/pairs.js";
import { Git } from "../git.js";
import { processInbox } from "../proposals/scanner.js";
import {
  appendProposals,
  nextProposalId,
  readProposals,
} from "../proposals/file.js";
import type { NewProposal } from "../proposals/types.js";
import {
  executeAction,
  type ExecutorContext,
} from "../executors/index.js";
import {
  generateLinkProposals,
  generateMergeProposals,
  generateParaProposals,
  type ProposedAction,
} from "../generators/index.js";
import { createEmbedder } from "../embeddings/embedder.js";
import { buildHubRegistry } from "../harvest/hubs.js";
import { planHarvest } from "./harvest.js";
import { runInsights } from "./insights.js";

export interface RunOptions {
  dryRun?: boolean;
  skipLlm?: boolean;
  skipPush?: boolean;
  /** Cap auto-exec moves on first runs to avoid 600+ moves in one go. Default: 50. */
  maxParaMoves?: number;
  /** Cap LINK proposals per run. Default: 50. */
  maxLinks?: number;
  /** Cap MERGE candidates examined by LLM. Default: 30. */
  maxMergeCandidates?: number;
  /** Cap daily notes planned for harvest per run. Default: 0 (off). */
  maxHarvest?: number;
}

interface VaultState {
  index: NoteIndex;
  store: EmbeddingStore;
}

async function loadState(cfg: Config): Promise<VaultState> {
  const index = await scanVault({
    vaultPath: cfg.vault.path,
    ignoredFolders: cfg.vault.ignored_folders,
  });
  const store = await loadEmbeddings({
    embeddingsDir: cfg.vault.embeddings_dir!,
    knownPaths: index.notes.keys(),
  });
  return { index, store };
}

export async function runFullPass(cfg: Config, opts: RunOptions = {}): Promise<void> {
  const t0 = Date.now();
  const proposalsFile = join(cfg.inbox.dir, cfg.inbox.proposals_file);
  console.log(`[run] start ${new Date(t0).toISOString()} · vault=${cfg.vault.path}`);

  // ---- Step 1: scan + load embeddings ----
  let state = await loadState(cfg);
  console.log(
    `[run] scanned ${state.index.notes.size} notes · ${state.store.numNotes} embedded`,
  );

  // ---- Step 2: refresh missing embeddings (best-effort) ----
  if (state.store.missingPaths.length > 0) {
    const result = await refreshMissingEmbeddings({
      vaultPath: cfg.vault.path,
      embeddingsDir: cfg.vault.embeddings_dir!,
      missingPaths: state.store.missingPaths,
      index: state.index,
    });
    if (result.skippedReason) {
      console.log(`[run] embed-missing: ${result.skippedReason}`);
    } else if (result.notesProcessed > 0) {
      console.log(
        `[run] embedded ${result.notesProcessed} new notes (${result.chunksEmbedded} chunks)`,
      );
      // Reload embeddings to include the freshly written files
      state.store = await loadEmbeddings({
        embeddingsDir: cfg.vault.embeddings_dir!,
        knownPaths: state.index.notes.keys(),
      });
    } else {
      console.log(`[run] embed-missing: 0 processed, ${result.skipped} skipped (empty notes)`);
    }
  }

  // ---- Step 3: process inbox (apply ticked checkboxes) ----
  const userEmail = process.env.GIT_AUTHOR_EMAIL ?? "vault-sidekick@scrungus";
  const userName = process.env.GIT_AUTHOR_NAME ?? "vault-sidekick";
  const git = new Git({
    cwd: cfg.vault.path,
    dryRun: opts.dryRun,
    userEmail,
    userName,
  });
  let inboxCtx: ExecutorContext = {
    vaultPath: cfg.vault.path,
    index: state.index,
    git,
  };
  if (existsSync(proposalsFile)) {
    const inboxResults = await processInbox({ proposalsFile, ctx: inboxCtx });
    const acted = inboxResults.filter((r) => !r.error);
    const failed = inboxResults.filter((r) => r.error);
    console.log(
      `[run] inbox: ${acted.length} processed (${acted.filter((r) => r.action === "approved").length} approved · ${acted.filter((r) => r.action === "rejected").length} rejected · ${acted.filter((r) => r.action === "reverted").length} reverted)`,
    );
    for (const f of failed) console.warn(`  ! ${f.id}: ${f.error}`);
    if (acted.some((r) => r.action !== "rejected")) {
      // State changed on disk — reload before generating new proposals.
      state = await loadState(cfg);
    }
  } else {
    console.log("[run] inbox: no proposals file yet");
  }

  // ---- Step 4: generate proposals ----
  const proposed: ProposedAction[] = [];

  if (opts.skipLlm) {
    console.log("[run] --skip-llm: only LINK proposals will be generated");
    const { pairs } = await findInsightPairs(state.index, state.store, {
      topK: cfg.insights.top_k,
      minSimilarity: cfg.insights.min_similarity,
      minGraphDistance: cfg.insights.min_graph_distance,
    });
    proposed.push(...generateLinkProposals(pairs).slice(0, opts.maxLinks ?? 50));
  } else {
    const { pairs } = await findInsightPairs(state.index, state.store, {
      topK: cfg.insights.top_k,
      minSimilarity: cfg.insights.min_similarity,
      minGraphDistance: cfg.insights.min_graph_distance,
    });
    proposed.push(...generateLinkProposals(pairs).slice(0, opts.maxLinks ?? 50));
    console.log(`[run] LINK: ${proposed.length} proposed`);

    const paraResults = await generateParaProposals(
      {
        vaultPath: cfg.vault.path,
        index: state.index,
        store: state.store,
        paraBuckets: cfg.para.buckets,
      },
      { maxNotes: opts.maxParaMoves ?? 50 },
    );
    proposed.push(...paraResults);
    console.log(`[run] PARA: ${paraResults.length} proposed`);

    const mergeResults = await generateMergeProposals(
      {
        vaultPath: cfg.vault.path,
        index: state.index,
        store: state.store,
        paraBuckets: cfg.para.buckets,
      },
      { minSimilarity: 0.95, maxCandidates: opts.maxMergeCandidates ?? 30 },
    );
    proposed.push(...mergeResults);
    console.log(`[run] MERGE: ${mergeResults.length} proposed (await approval)`);
  }

  // ---- Step 5: execute auto-exec proposals, write all proposals to inbox ----
  const existing = await readProposals(proposalsFile);
  const written: NewProposal[] = [];

  for (const p of proposed) {
    const id = nextProposalId([...existing, ...written.map(asPlaceholder)], p.kind);

    if (p.autoExec && !opts.dryRun) {
      try {
        const ctx: ExecutorContext = {
          vaultPath: cfg.vault.path,
          index: state.index,
          git,
        };
        const result = await executeAction(p.action, ctx, id);
        if (!result.commitSha) {
          // Idempotent no-op (e.g. link already existed) — still record the proposal.
          written.push({
            id,
            kind: p.kind,
            title: p.title,
            reason: (p.reason ?? "") + " · (no-op: already present)",
            confidence: p.confidence,
            action: p.action,
            initialState: "applied",
          });
        } else {
          written.push({
            id,
            kind: p.kind,
            title: p.title,
            reason: p.reason,
            confidence: p.confidence,
            action: p.action,
            initialState: "applied",
            appliedCommit: result.commitSha,
          });
          // Re-scan the vault so subsequent ops see the new state.
          // Skip re-scan for link-add (only modifies content, not paths).
          if (p.action.op !== "link_add") {
            state.index = await scanVault({
              vaultPath: cfg.vault.path,
              ignoredFolders: cfg.vault.ignored_folders,
            });
          }
        }
      } catch (err) {
        console.warn(`[run] auto-exec ${id} failed: ${(err as Error).message}`);
      }
    } else {
      written.push({
        id,
        kind: p.kind,
        title: p.title,
        reason: p.reason,
        confidence: p.confidence,
        action: p.action,
        initialState: "proposed",
      });
    }
  }

  // ---- Step 5b: plan daily-note harvests (proposal-based, never auto-exec) ----
  if (!opts.skipLlm && (opts.maxHarvest ?? 0) > 0) {
    const embed = await createEmbedder(cfg.vault.path);
    if (!embed) {
      console.log("[run] HARVEST skipped — no embedding key configured");
    } else {
      const hubRegistry = buildHubRegistry(state.index, cfg.harvest.hub_tag);
      const harvestProposals = await planHarvest(
        {
          cfg,
          index: state.index,
          store: state.store,
          hubRegistry,
          embed,
          existingProposals: [...existing, ...written].map((p) => ({
            id: p.id,
            kind: p.kind,
          })),
        },
        opts.maxHarvest!,
      );
      written.push(...harvestProposals);
      console.log(`[run] HARVEST: ${harvestProposals.length} proposed`);
    }
  }

  if (written.length > 0 && !opts.dryRun) {
    await appendProposals(proposalsFile, written);
    console.log(`[run] wrote ${written.length} proposals to ${proposalsFile}`);
  } else if (opts.dryRun) {
    console.log(`[run] --dry-run: would have written ${written.length} proposals`);
  }

  // ---- Step 6: daily insights report ----
  await runInsights(cfg);

  // ---- Step 6b: commit loose inbox outputs ----
  // Executors commit their own content changes, but proposals.md, the
  // harvest-ledger, the fleeting collector, and the daily-insights report are
  // written outside any executor. Without this commit they'd never be pushed.
  if (!opts.dryRun) {
    const inboxRel = relative(cfg.vault.path, cfg.inbox.dir);
    const housekeepingSha = await git.commitPaths(
      "vault-sidekick: update inbox (proposals, insights, ledger)",
      [inboxRel],
    );
    if (housekeepingSha) {
      console.log(`[run] committed inbox outputs (${housekeepingSha.slice(0, 7)})`);
    }
  }

  // ---- Step 7: push to origin (batched) ----
  if (!opts.dryRun && !opts.skipPush && cfg.git.enabled) {
    const ahead = await git.commitsAheadOf(cfg.git.remote, "main");
    if (ahead.length > 0) {
      try {
        await git.push({ remote: cfg.git.remote, branch: "main" });
        console.log(`[run] pushed ${ahead.length} commits to ${cfg.git.remote}/main`);
      } catch (err) {
        console.warn(`[run] push failed (will retry next run): ${(err as Error).message}`);
      }
    } else {
      console.log("[run] nothing to push");
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[run] done in ${elapsed}s`);
}

/** Build a minimal stub so nextProposalId can dedupe within the same run. */
function asPlaceholder(p: NewProposal): {
  id: string;
  kind: NewProposal["kind"];
} {
  return { id: p.id, kind: p.kind };
}
