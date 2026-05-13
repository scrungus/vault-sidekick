import { readProposals, updateProposalState } from "./file.js";
import type { Proposal } from "./types.js";
import {
  type ExecutorContext,
  type ExecutorResult,
  executeAction,
  executeRevert,
} from "../executors/index.js";

export interface ProcessedProposal {
  id: string;
  action: "approved" | "rejected" | "reverted";
  result?: ExecutorResult;
  error?: string;
}

/**
 * Scan proposals.md for newly-ticked checkboxes and dispatch the corresponding ops.
 *
 *   - `[x] approve` on a `proposed` proposal → executeAction, state→applied
 *   - `[x] reject`  on a `proposed` proposal → state→rejected
 *   - `[x] revert this` on an `applied` proposal → executeRevert, state→reverted
 *
 * Errors are caught per-proposal so one bad apply doesn't stop the queue.
 */
export async function processInbox(opts: {
  proposalsFile: string;
  ctx: ExecutorContext;
}): Promise<ProcessedProposal[]> {
  const proposals = await readProposals(opts.proposalsFile);
  const results: ProcessedProposal[] = [];

  for (const p of proposals) {
    const decision = classify(p);
    if (!decision) continue;

    try {
      if (decision === "approve") {
        const result = await executeAction(p.action, opts.ctx, p.id);
        await updateProposalState(opts.proposalsFile, p.id, "applied", {
          appliedCommit: result.commitSha ?? undefined,
        });
        results.push({ id: p.id, action: "approved", result });
      } else if (decision === "reject") {
        await updateProposalState(opts.proposalsFile, p.id, "rejected");
        results.push({ id: p.id, action: "rejected" });
      } else if (decision === "revert") {
        if (!p.appliedCommit) {
          results.push({
            id: p.id,
            action: "reverted",
            error: "no appliedCommit recorded; can't revert",
          });
          continue;
        }
        const result = await executeRevert(p.appliedCommit, opts.ctx, p.id);
        await updateProposalState(opts.proposalsFile, p.id, "reverted", {
          appliedCommit: p.appliedCommit,
          revertedCommit: result.commitSha ?? undefined,
        });
        results.push({ id: p.id, action: "reverted", result });
      }
    } catch (err) {
      results.push({
        id: p.id,
        action: decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "reverted",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

function classify(p: Proposal): "approve" | "reject" | "revert" | null {
  if (p.state === "proposed" && p.approveTicked) return "approve";
  if (p.state === "proposed" && p.rejectTicked) return "reject";
  if (p.state === "applied" && p.revertTicked) return "revert";
  return null;
}
