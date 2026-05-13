import { readFile, writeFile } from "node:fs/promises";
import type { NoteIndex } from "./scanner.js";

/**
 * Rewrite wikilinks across the vault to reflect a rename or move.
 *
 * Wikilink forms handled:
 *   [[Name]]                  — bare stem
 *   [[Name|alias]]            — bare stem with display alias
 *   [[Name#heading]]          — heading anchor
 *   [[Name#^block-id]]        — block reference
 *   [[Name.md]]               — explicit .md suffix
 *   [[folder/Name]]           — path-explicit
 *   [[folder/Name.md|alias]]  — combinations of the above
 *
 * Rules:
 *   • Bare stem references update on stem rename (Obsidian resolves them
 *     to the unique note with that stem regardless of folder).
 *   • Path-explicit references update only when the old folder prefix matches
 *     the old note location. Other notes that happen to share the stem are
 *     left alone.
 *   • Embeds `![[…]]` are handled the same way as `[[…]]`.
 */

export interface RewriteResult {
  filesModified: string[];
  linksChanged: number;
}

export async function rewriteLinks(opts: {
  oldRelPath: string;
  newRelPath: string;
  index: NoteIndex;
  /** Paths to skip (in addition to oldRelPath which is always skipped). */
  skipPaths?: string[];
  /** When true, do not write to disk — return the would-be result. */
  dryRun?: boolean;
}): Promise<RewriteResult> {
  const oldStem = stemOf(opts.oldRelPath);
  const newStem = stemOf(opts.newRelPath);
  const oldFolder = folderOf(opts.oldRelPath);
  const newFolder = folderOf(opts.newRelPath);

  const stemChanged = oldStem !== newStem;
  const skip = new Set([opts.oldRelPath, ...(opts.skipPaths ?? [])]);

  let totalLinks = 0;
  const filesModified: string[] = [];

  for (const note of opts.index.notes.values()) {
    if (skip.has(note.relPath)) continue;
    const content = await readFile(note.absPath, "utf-8");
    const { text: updated, count } = rewriteInText(content, {
      oldStem,
      newStem,
      oldFolder,
      newFolder,
      stemChanged,
    });
    if (count > 0) {
      totalLinks += count;
      filesModified.push(note.relPath);
      if (!opts.dryRun) {
        await writeFile(note.absPath, updated, "utf-8");
      }
    }
  }

  return { filesModified, linksChanged: totalLinks };
}

interface RewriteParams {
  oldStem: string;
  newStem: string;
  oldFolder: string;
  newFolder: string;
  stemChanged: boolean;
}

const WIKILINK_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

function rewriteInText(content: string, p: RewriteParams): { text: string; count: number } {
  let count = 0;
  const updated = content.replace(WIKILINK_RE, (full, bang: string, inner: string) => {
    const replaced = rewriteLinkInner(inner, p);
    if (replaced === inner) return full;
    count++;
    return `${bang}[[${replaced}]]`;
  });
  return { text: updated, count };
}

/**
 * `inner` is everything between `[[` and `]]`, possibly `target | alias` and/or `target # heading`.
 * The target portion is everything up to the first `|`, `#`, or `^` (in alias/heading/block order).
 */
function rewriteLinkInner(inner: string, p: RewriteParams): string {
  const splitMatch = inner.match(/^([^|#^]+)(.*)$/s);
  if (!splitMatch || !splitMatch[1]) return inner;
  const target = splitMatch[1];
  const suffix = splitMatch[2] ?? "";

  const hasMdSuffix = target.endsWith(".md");
  const normalized = hasMdSuffix ? target.slice(0, -3) : target;
  const lastSlash = normalized.lastIndexOf("/");
  const targetStem = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const targetFolder = lastSlash >= 0 ? normalized.slice(0, lastSlash) : "";

  if (targetStem.toLowerCase() !== p.oldStem.toLowerCase()) {
    return inner;
  }

  if (targetFolder === "") {
    // Bare stem reference: only needs updating when the stem changed.
    if (!p.stemChanged) return inner;
    const replacement = hasMdSuffix ? `${p.newStem}.md` : p.newStem;
    return replacement + suffix;
  }

  // Path-explicit reference: only update if the folder matches the OLD location.
  if (targetFolder !== p.oldFolder) return inner;
  const newPath = p.newFolder ? `${p.newFolder}/${p.newStem}` : p.newStem;
  const replacement = hasMdSuffix ? `${newPath}.md` : newPath;
  return replacement + suffix;
}

function stemOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.md$/, "");
}

function folderOf(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx >= 0 ? relPath.slice(0, idx) : "";
}
