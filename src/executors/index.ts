import { readFile, writeFile, unlink, mkdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Git } from "../git.js";
import type { NoteIndex } from "../vault/scanner.js";
import { rewriteLinks } from "../vault/rewriter.js";
import type {
  LinkAddAction,
  MergeAction,
  MoveAction,
  ProposalAction,
} from "../proposals/types.js";

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

const RELATED_HEADING = "## Related";

function stemOf(relPath: string): string {
  return (relPath.split("/").pop() ?? relPath).replace(/\.md$/, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end < 0) return md;
  return md.slice(end + 4).replace(/^\s+/, "");
}

function appendToRelated(content: string, linkLine: string): string {
  const heading = new RegExp(`^${escapeRegExp(RELATED_HEADING)}\\s*$`, "m");
  const match = content.match(heading);
  if (match && match.index !== undefined) {
    const sectionStart = match.index;
    const afterHeading = sectionStart + match[0].length;
    const nextSection = content.slice(afterHeading).search(/\n##\s/);
    const insertAt = nextSection >= 0 ? afterHeading + nextSection : content.length;
    const before = content.slice(0, insertAt).replace(/\s*$/, "");
    const after = content.slice(insertAt);
    return `${before}\n${linkLine}\n${after.startsWith("\n") ? after : "\n" + after}`;
  }
  const sep = content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${sep}${RELATED_HEADING}\n\n${linkLine}\n`;
}

export async function executeLinkAdd(
  action: LinkAddAction,
  ctx: ExecutorContext,
  propId: string,
): Promise<ExecutorResult> {
  const sourceNote = ctx.index.notes.get(action.in);
  const targetNote = ctx.index.notes.get(action.target);
  if (!sourceNote) throw new Error(`link-add source not found: ${action.in}`);
  if (!targetNote) throw new Error(`link-add target not found: ${action.target}`);

  const targetStem = stemOf(targetNote.relPath);
  const content = await readFile(sourceNote.absPath, "utf-8");

  const existing = new RegExp(`\\[\\[${escapeRegExp(targetStem)}(?:[|#^][^\\]]*)?\\]\\]`, "i");
  if (existing.test(content)) {
    return { commitSha: null, filesAffected: [], notes: "link already present, no-op" };
  }

  const updated = appendToRelated(content, `- [[${targetStem}]]`);
  await writeFile(sourceNote.absPath, updated, "utf-8");
  await ctx.git.stage([sourceNote.relPath]);
  const sha = await ctx.git.commit(
    `${propId}: add link [[${targetStem}]] to ${sourceNote.relPath}`,
  );
  return { commitSha: sha, filesAffected: [sourceNote.relPath] };
}

export async function executeMove(
  action: MoveAction,
  ctx: ExecutorContext,
  propId: string,
): Promise<ExecutorResult> {
  const sourceNote = ctx.index.notes.get(action.from);
  if (!sourceNote) throw new Error(`move source not found: ${action.from}`);

  const targetAbs = join(ctx.vaultPath, action.to);
  try {
    await stat(targetAbs);
    throw new Error(`move target already exists: ${action.to}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await mkdir(dirname(targetAbs), { recursive: true });
  await rename(sourceNote.absPath, targetAbs);

  const rewrite = await rewriteLinks({
    oldRelPath: action.from,
    newRelPath: action.to,
    index: ctx.index,
  });

  const stagePaths = [action.from, action.to, ...rewrite.filesModified];
  await ctx.git.stage(stagePaths);
  const sha = await ctx.git.commit(
    `${propId}: move ${action.from} → ${action.to}` +
      (rewrite.filesModified.length
        ? ` (+${rewrite.filesModified.length} link updates)`
        : ""),
  );
  return { commitSha: sha, filesAffected: stagePaths };
}

export async function executeMerge(
  action: MergeAction,
  ctx: ExecutorContext,
  propId: string,
): Promise<ExecutorResult> {
  const fromNote = ctx.index.notes.get(action.from);
  const intoNote = ctx.index.notes.get(action.into);
  if (!fromNote) throw new Error(`merge source not found: ${action.from}`);
  if (!intoNote) throw new Error(`merge target not found: ${action.into}`);
  if (action.from === action.into) {
    throw new Error(`merge: source and target are the same (${action.from})`);
  }

  const fromContent = await readFile(fromNote.absPath, "utf-8");
  const intoContent = await readFile(intoNote.absPath, "utf-8");

  const fromBody = stripFrontmatter(fromContent).trim();
  const fromStem = stemOf(action.from);

  const intoTrimmed = intoContent.replace(/\s*$/, "");
  const merged =
    `${intoTrimmed}\n\n## Merged from [[${fromStem}]]\n\n${fromBody}\n`;

  await writeFile(intoNote.absPath, merged, "utf-8");
  await unlink(fromNote.absPath);

  // Redirect wikilinks across the vault; skip target so we don't create self-links.
  const rewrite = await rewriteLinks({
    oldRelPath: action.from,
    newRelPath: action.into,
    index: ctx.index,
    skipPaths: [action.into],
  });

  const stagePaths = [action.from, action.into, ...rewrite.filesModified];
  await ctx.git.stage(stagePaths);
  const sha = await ctx.git.commit(
    `${propId}: merge ${action.from} → ${action.into}` +
      (rewrite.filesModified.length
        ? ` (+${rewrite.filesModified.length} link updates)`
        : ""),
  );
  return { commitSha: sha, filesAffected: stagePaths };
}

export async function executeRevert(
  commitSha: string,
  ctx: ExecutorContext,
  propId: string,
): Promise<ExecutorResult> {
  const newSha = await ctx.git.revert(commitSha, `${propId}: revert ${commitSha.slice(0, 7)}`);
  return { commitSha: newSha, filesAffected: [] };
}

/** Dispatch helper for proposal actions. */
export async function executeAction(
  action: ProposalAction,
  ctx: ExecutorContext,
  propId: string,
): Promise<ExecutorResult> {
  switch (action.op) {
    case "link_add":
      return executeLinkAdd(action, ctx, propId);
    case "move":
      return executeMove(action, ctx, propId);
    case "merge":
      return executeMerge(action, ctx, propId);
    default: {
      const _exhaustive: never = action;
      throw new Error(`unknown action op: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
