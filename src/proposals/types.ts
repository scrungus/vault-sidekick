export type ProposalKind = "MERGE" | "LINK" | "PARA" | "HARVEST";
export type ProposalState = "proposed" | "applied" | "rejected" | "reverted";
export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface MergeAction {
  op: "merge";
  into: string;
  from: string;
}

export interface LinkAddAction {
  op: "link_add";
  /** Source note path (the one that gets the new link). */
  in: string;
  /** Target note path (the one being linked to). */
  target: string;
}

export interface MoveAction {
  op: "move";
  from: string;
  to: string;
}

export interface HarvestAction {
  op: "harvest";
  /** Daily note being harvested (relPath). */
  daily: string;
  /** Where the daily note moves once harvested. */
  archive_to: string;
  /** Vault-relative path to the sidecar JSON plan (full per-block detail). */
  plan: string;
  /** Vault-relative path to the harvest ledger. */
  ledger: string;
  /** Content hash of the daily at plan time. A re-run re-plans the daily only
   *  if its current hash differs (i.e. the note was edited). */
  content_hash: string;
}

export type ProposalAction = MergeAction | LinkAddAction | MoveAction | HarvestAction;

export interface Proposal {
  id: string;
  kind: ProposalKind;
  title: string;
  reason?: string;
  confidence?: Confidence;
  state: ProposalState;
  /** Set when state ∈ {applied, reverted}. */
  appliedCommit?: string;
  /** Set when state === reverted: the SHA of the revert commit. */
  revertedCommit?: string;
  /** Latest ISO timestamp recorded in the state line. */
  stateTimestamp?: string;
  action: ProposalAction;
  approveTicked: boolean;
  rejectTicked: boolean;
  revertTicked: boolean;
}

export interface NewProposal {
  id: string;
  kind: ProposalKind;
  title: string;
  reason?: string;
  confidence?: Confidence;
  action: ProposalAction;
  /** "proposed" for destructive ops awaiting checkbox; "applied" if auto-executed before write. */
  initialState: "proposed" | "applied";
  /** Required if initialState === "applied". */
  appliedCommit?: string;
}
