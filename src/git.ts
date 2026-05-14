import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface GitOptions {
  /** Working tree. Required. */
  cwd: string;
  /** When true, write operations (add/rm/commit/revert/push) are skipped. */
  dryRun?: boolean;
  /** Override commit author email. Pulled from `git config` if omitted. */
  userEmail?: string;
  /** Override commit author name. Pulled from `git config` if omitted. */
  userName?: string;
}

export class Git {
  constructor(private opts: GitOptions) {}

  /** Run any git subcommand; returns stdout. Errors throw with stderr in the message. */
  async run(...args: string[]): Promise<string> {
    const env = { ...process.env };
    const configArgs: string[] = [];
    if (this.opts.userEmail) configArgs.push("-c", `user.email=${this.opts.userEmail}`);
    if (this.opts.userName) configArgs.push("-c", `user.name=${this.opts.userName}`);
    try {
      const { stdout } = await execFileP("git", [...configArgs, ...args], {
        cwd: this.opts.cwd,
        env,
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(`git ${args.join(" ")} failed: ${(e.stderr || e.message || "").trim()}`);
    }
  }

  private isWriteOp(args: string[]): boolean {
    const cmd = args[0] ?? "";
    return ["add", "rm", "mv", "commit", "revert", "reset", "tag", "push", "checkout"].includes(
      cmd,
    );
  }

  async maybeRun(...args: string[]): Promise<string> {
    if (this.opts.dryRun && this.isWriteOp(args)) {
      return "";
    }
    return this.run(...args);
  }

  async stage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.maybeRun("add", "--", ...paths);
  }

  async stageAll(): Promise<void> {
    await this.maybeRun("add", "-A");
  }

  /** Commit currently-staged changes. Returns the new HEAD sha, or null if nothing was staged. */
  async commit(message: string): Promise<string | null> {
    const staged = await this.run("diff", "--cached", "--name-only");
    if (!staged.trim()) return null;
    if (this.opts.dryRun) return "DRY-RUN-SHA";
    await this.maybeRun("commit", "-m", message);
    return (await this.run("rev-parse", "HEAD")).trim();
  }

  /**
   * Commit ONLY the given paths, ignoring anything else already staged.
   * This keeps each operation's commit surgical — `git commit` with no
   * pathspec would otherwise sweep in unrelated staged changes.
   */
  async commitPaths(message: string, paths: string[]): Promise<string | null> {
    if (paths.length === 0) return null;
    // Stage these paths (picks up new/modified/deleted), then commit with an
    // explicit pathspec so other staged changes are left untouched.
    await this.maybeRun("add", "--", ...paths);
    if (this.opts.dryRun) return "DRY-RUN-SHA";
    const staged = await this.run("diff", "--cached", "--name-only", "--", ...paths);
    if (!staged.trim()) return null;
    await this.maybeRun("commit", "-m", message, "--", ...paths);
    return (await this.run("rev-parse", "HEAD")).trim();
  }

  async revert(sha: string, message?: string): Promise<string> {
    if (this.opts.dryRun) return "DRY-RUN-SHA";
    if (message) {
      await this.maybeRun("revert", "--no-commit", sha);
      await this.maybeRun("commit", "-m", message);
    } else {
      await this.maybeRun("revert", "--no-edit", sha);
    }
    return (await this.run("rev-parse", "HEAD")).trim();
  }

  async currentSha(): Promise<string> {
    return (await this.run("rev-parse", "HEAD")).trim();
  }

  async hasUncommittedChanges(): Promise<boolean> {
    return (await this.run("status", "--porcelain")).trim().length > 0;
  }

  /** Pushes a branch (and optionally tags) to a remote, setting upstream tracking. */
  async push(opts: { remote?: string; branch?: string; tags?: boolean } = {}): Promise<void> {
    const remote = opts.remote ?? "origin";
    const branch = opts.branch ?? "main";
    // -u sets/refreshes upstream tracking so a bare `git push` works afterwards.
    await this.maybeRun("push", "-u", remote, branch);
    if (opts.tags) {
      await this.maybeRun("push", remote, "--tags");
    }
  }

  /** Returns the list of commits ahead of <remote>/<branch>, oldest-first. */
  async commitsAheadOf(remote = "origin", branch = "main"): Promise<string[]> {
    try {
      const out = await this.run("rev-list", "--reverse", `${remote}/${branch}..HEAD`);
      return out.trim() ? out.trim().split("\n") : [];
    } catch {
      // Remote ref might not exist locally; treat as nothing pushed yet.
      return [];
    }
  }
}
