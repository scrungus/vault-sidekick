import type { Git } from "../git.js";
import type { NoteIndex } from "../vault/scanner.js";

export interface ExecutorContext {
  vaultPath: string;
  index: NoteIndex;
  git: Git;
}

export interface ExecutorResult {
  /** Newly created commit SHA, or null if nothing changed (idempotent no-op). */
  commitSha: string | null;
  filesAffected: string[];
  notes?: string;
}
