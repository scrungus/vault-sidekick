import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";

export interface Note {
  absPath: string;
  relPath: string;
  stem: string;
  title: string;
  mtimeMs: number;
  frontmatter: Record<string, unknown> | null;
  rawLinks: string[];
  tags: string[];
}

export interface NoteIndex {
  notes: Map<string, Note>;
  byStem: Map<string, string[]>;
  outgoing: Map<string, string[]>;
  backlinks: Map<string, string[]>;
}

const WIKILINK_RE = /\[\[([^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|[^\[\]]+)?\]\]/g;
const TAG_RE = /(?:^|\s)#([A-Za-z][\w/-]*)/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const CODE_FENCE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;

function stripCode(text: string): string {
  return text.replace(CODE_FENCE_RE, "").replace(INLINE_CODE_RE, "");
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown> | null;
  body: string;
} {
  const m = content.match(FRONTMATTER_RE);
  if (!m || m[1] === undefined) return { frontmatter: null, body: content };
  try {
    const parsed = parseYaml(m[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        frontmatter: parsed as Record<string, unknown>,
        body: content.slice(m[0].length),
      };
    }
  } catch {
    // Invalid YAML — treat as no frontmatter
  }
  return { frontmatter: null, body: content };
}

function extractTitle(
  stem: string,
  frontmatter: Record<string, unknown> | null,
  body: string,
): string {
  if (frontmatter && typeof frontmatter.title === "string") return frontmatter.title;
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1 && h1[1]) return h1[1].trim();
  return stem;
}

function extractLinks(body: string): string[] {
  const clean = stripCode(body);
  const links: string[] = [];
  for (const m of clean.matchAll(WIKILINK_RE)) {
    if (m[1]) links.push(m[1].trim());
  }
  return links;
}

function extractTags(body: string, frontmatter: Record<string, unknown> | null): string[] {
  const tags = new Set<string>();
  const clean = stripCode(body);
  for (const m of clean.matchAll(TAG_RE)) {
    if (m[1]) tags.add(m[1]);
  }
  if (frontmatter) {
    const fmTags = frontmatter.tags;
    if (typeof fmTags === "string") {
      for (const t of fmTags.split(/[\s,]+/)) {
        if (t) tags.add(t.replace(/^#/, ""));
      }
    } else if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        if (typeof t === "string") tags.add(t.replace(/^#/, ""));
      }
    }
  }
  return [...tags];
}

async function walk(
  dir: string,
  vaultRoot: string,
  ignored: Set<string>,
): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(vaultRoot, abs);
    const topSeg = rel.split("/")[0] ?? "";
    if (ignored.has(topSeg)) continue;
    // Always ignore dot-folders we haven't whitelisted (e.g. .git, .obsidian, .smart-connections)
    if (entry.isDirectory() && entry.name.startsWith(".") && !ignored.has(entry.name)) continue;
    if (entry.isDirectory()) {
      results.push(...(await walk(abs, vaultRoot, ignored)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(abs);
    }
  }
  return results;
}

export async function scanVault(opts: {
  vaultPath: string;
  ignoredFolders: string[];
}): Promise<NoteIndex> {
  const ignored = new Set([...opts.ignoredFolders, ".git", ".obsidian", ".trash", ".smart-connections"]);
  const absPaths = await walk(opts.vaultPath, opts.vaultPath, ignored);

  const notes = new Map<string, Note>();
  const byStem = new Map<string, string[]>();

  for (const absPath of absPaths) {
    const relPath = relative(opts.vaultPath, absPath);
    const fileName = relPath.split("/").pop() ?? "";
    const stem = fileName.replace(/\.md$/, "");
    const content = await readFile(absPath, "utf-8");
    const st = await stat(absPath);
    const { frontmatter, body } = parseFrontmatter(content);
    const title = extractTitle(stem, frontmatter, body);
    const rawLinks = extractLinks(body);
    const tags = extractTags(body, frontmatter);

    notes.set(relPath, {
      absPath,
      relPath,
      stem,
      title,
      mtimeMs: st.mtimeMs,
      frontmatter,
      rawLinks,
      tags,
    });

    const stemKey = stem.toLowerCase();
    const bucket = byStem.get(stemKey);
    if (bucket) bucket.push(relPath);
    else byStem.set(stemKey, [relPath]);
  }

  // Resolve outgoing links + derive backlinks
  const outgoing = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();

  for (const note of notes.values()) {
    const resolved = new Set<string>();
    for (const raw of note.rawLinks) {
      // Obsidian wikilinks: try stem-match first (case-insensitive),
      // then fall back to a full relative-path match.
      const candidates = byStem.get(raw.toLowerCase());
      if (candidates && candidates[0]) {
        resolved.add(candidates[0]);
        continue;
      }
      const candidate = raw.endsWith(".md") ? raw : `${raw}.md`;
      if (notes.has(candidate)) resolved.add(candidate);
    }
    const resolvedArr = [...resolved];
    outgoing.set(note.relPath, resolvedArr);
    for (const target of resolvedArr) {
      const bucket = backlinks.get(target);
      if (bucket) bucket.push(note.relPath);
      else backlinks.set(target, [note.relPath]);
    }
  }

  return { notes, byStem, outgoing, backlinks };
}

export interface ScanStats {
  totalNotes: number;
  totalLinks: number;
  orphans: number; // notes with no outgoing and no incoming wikilinks
  brokenLinks: number; // raw links that could not be resolved
  ambiguousStems: number; // stems shared by 2+ notes
  notesWithFrontmatter: number;
  notesWithTags: number;
  uniqueTags: number;
}

export function summarise(index: NoteIndex): ScanStats {
  let totalLinks = 0;
  let orphans = 0;
  let brokenLinks = 0;
  let notesWithFrontmatter = 0;
  let notesWithTags = 0;
  const tagSet = new Set<string>();

  for (const note of index.notes.values()) {
    const out = index.outgoing.get(note.relPath) ?? [];
    const back = index.backlinks.get(note.relPath) ?? [];
    totalLinks += out.length;
    if (out.length === 0 && back.length === 0) orphans++;
    if (note.frontmatter) notesWithFrontmatter++;
    if (note.tags.length > 0) notesWithTags++;
    for (const t of note.tags) tagSet.add(t);
    brokenLinks += Math.max(0, note.rawLinks.length - out.length);
  }

  let ambiguous = 0;
  for (const v of index.byStem.values()) if (v.length > 1) ambiguous++;

  return {
    totalNotes: index.notes.size,
    totalLinks,
    orphans,
    brokenLinks,
    ambiguousStems: ambiguous,
    notesWithFrontmatter,
    notesWithTags,
    uniqueTags: tagSet.size,
  };
}
