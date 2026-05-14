import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
  Confidence,
  NewProposal,
  Proposal,
  ProposalAction,
  ProposalKind,
  ProposalState,
} from "./types.js";

const FILE_HEADER =
  "# Vault Sidekick Proposals\n\n" +
  "This file is append-only. vault-sidekick adds new proposals at the end; tick a checkbox to approve, reject, or revert.\n\n" +
  "**Workflow:**\n" +
  "- Destructive ops (MERGE) start as `proposed`. Tick `approve` to execute on next run, `reject` to dismiss.\n" +
  "- Non-destructive ops (LINK, PARA) are auto-applied and shown here with `state: applied`. Tick `revert this` to undo.\n\n" +
  "Each proposal has a YAML block describing the action. Don't edit it — vault-sidekick parses it verbatim.\n\n" +
  "---\n\n";

const SECTION_DELIM = "\n---\n\n";

function nowIso(): string {
  return new Date().toISOString();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Render a single proposal block. */
function renderProposal(p: NewProposal & { stateTimestamp?: string }): string {
  const lines: string[] = [];
  lines.push(`### ${p.id} · ${p.kind}`);
  lines.push("");
  lines.push(`**title**: ${p.title}`);
  if (p.reason) lines.push(`**reason**: ${p.reason}`);
  if (p.confidence) lines.push(`**confidence**: ${p.confidence}`);
  lines.push(renderStateLine(p.initialState, p.appliedCommit, undefined, p.stateTimestamp ?? nowIso()));
  lines.push("");
  lines.push("```yaml");
  lines.push(stringifyYaml(p.action).trim());
  lines.push("```");
  lines.push("");
  if (p.initialState === "proposed") {
    lines.push("- [ ] approve");
    lines.push("- [ ] reject");
  } else {
    lines.push("- [ ] revert this");
  }
  return lines.join("\n");
}

function renderStateLine(
  state: ProposalState,
  appliedCommit: string | undefined,
  revertedCommit: string | undefined,
  timestamp: string,
): string {
  const parts = [`**state**: ${state}`];
  if (appliedCommit) parts.push(`commit \`${appliedCommit}\``);
  if (revertedCommit) parts.push(`reverted-by \`${revertedCommit}\``);
  parts.push(timestamp);
  return parts.join(" · ");
}

/** Split a file's contents into raw section strings (one per proposal). */
function splitSections(text: string): string[] {
  // Sections are delimited by lines containing only `---`.
  // The header block above the first separator is ignored.
  const parts = text.split(/\n---\s*\n/);
  // Drop the file-level header (first chunk that doesn't start with ###)
  return parts.filter((p) => /^###\s+PROP-/m.test(p));
}

function parseSection(section: string): Proposal | null {
  const header = section.match(/^###\s+(PROP-\S+)\s+·\s+(MERGE|LINK|PARA|HARVEST)\s*$/m);
  if (!header) return null;
  const id = header[1]!;
  const kind = header[2] as ProposalKind;

  const titleMatch = section.match(/^\*\*title\*\*:\s+(.+)$/m);
  const reasonMatch = section.match(/^\*\*reason\*\*:\s+(.+)$/m);
  const confidenceMatch = section.match(/^\*\*confidence\*\*:\s+(EXTRACTED|INFERRED|AMBIGUOUS)\s*$/m);
  const stateMatch = section.match(/^\*\*state\*\*:\s+(.+)$/m);

  let state: ProposalState = "proposed";
  let appliedCommit: string | undefined;
  let revertedCommit: string | undefined;
  let stateTimestamp: string | undefined;
  if (stateMatch && stateMatch[1]) {
    const stateLine = stateMatch[1];
    const sm = stateLine.match(/^(proposed|applied|rejected|reverted)\b/);
    if (sm && sm[1]) state = sm[1] as ProposalState;
    const cm = stateLine.match(/commit\s+`([0-9a-f]+)`/);
    if (cm && cm[1]) appliedCommit = cm[1];
    const rm = stateLine.match(/reverted-by\s+`([0-9a-f]+)`/);
    if (rm && rm[1]) revertedCommit = rm[1];
    const tm = stateLine.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
    if (tm && tm[1]) stateTimestamp = tm[1];
  }

  const yamlMatch = section.match(/```yaml\s*\n([\s\S]*?)\n```/);
  if (!yamlMatch || !yamlMatch[1]) return null;
  let action: ProposalAction;
  try {
    const parsed = parseYaml(yamlMatch[1]) as ProposalAction;
    action = parsed;
  } catch {
    return null;
  }

  const approveTicked = /^-\s*\[x\]\s+approve\b/im.test(section);
  const rejectTicked = /^-\s*\[x\]\s+reject\b/im.test(section);
  const revertTicked = /^-\s*\[x\]\s+revert this\b/im.test(section);

  return {
    id,
    kind,
    title: titleMatch && titleMatch[1] ? titleMatch[1].trim() : id,
    reason: reasonMatch && reasonMatch[1] ? reasonMatch[1].trim() : undefined,
    confidence:
      confidenceMatch && confidenceMatch[1] ? (confidenceMatch[1] as Confidence) : undefined,
    state,
    appliedCommit,
    revertedCommit,
    stateTimestamp,
    action,
    approveTicked,
    rejectTicked,
    revertTicked,
  };
}

export async function readProposals(filePath: string): Promise<Proposal[]> {
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, "utf-8");
  const out: Proposal[] = [];
  for (const sec of splitSections(text)) {
    const p = parseSection(sec);
    if (p) out.push(p);
  }
  return out;
}

export async function appendProposals(
  filePath: string,
  newProposals: NewProposal[],
): Promise<void> {
  if (newProposals.length === 0) return;
  await mkdir(dirname(filePath), { recursive: true });
  let existing: string;
  if (existsSync(filePath)) {
    existing = await readFile(filePath, "utf-8");
    if (!existing.endsWith("\n")) existing += "\n";
    if (!existing.endsWith("---\n") && !existing.endsWith("---\n\n")) {
      existing += "\n---\n\n";
    }
  } else {
    existing = FILE_HEADER;
  }
  const blocks = newProposals.map(renderProposal).join(SECTION_DELIM);
  const out = existing + blocks + "\n";
  await writeFile(filePath, out, "utf-8");
}

export async function updateProposalState(
  filePath: string,
  id: string,
  newState: ProposalState,
  opts: { appliedCommit?: string; revertedCommit?: string } = {},
): Promise<void> {
  const text = await readFile(filePath, "utf-8");
  const sectionStart = text.search(new RegExp(`^### ${escapeRegex(id)}\\s+·`, "m"));
  if (sectionStart < 0) throw new Error(`Proposal ${id} not found in ${filePath}`);
  // Find end of section: next `\n---\n` or end of file
  let sectionEnd = text.indexOf("\n---\n", sectionStart);
  if (sectionEnd < 0) sectionEnd = text.length;
  const section = text.slice(sectionStart, sectionEnd);
  const newStateLine = renderStateLine(
    newState,
    opts.appliedCommit,
    opts.revertedCommit,
    nowIso(),
  );
  let updated: string;
  if (/^\*\*state\*\*:/m.test(section)) {
    updated = section.replace(/^\*\*state\*\*:.*$/m, newStateLine);
  } else {
    // Insert state line right after the **title** line, or after the heading
    const titleIdx = section.search(/^\*\*title\*\*:.+$/m);
    if (titleIdx >= 0) {
      const titleEnd = section.indexOf("\n", titleIdx);
      updated =
        section.slice(0, titleEnd + 1) +
        newStateLine +
        "\n" +
        section.slice(titleEnd + 1);
    } else {
      updated = section + "\n" + newStateLine + "\n";
    }
  }
  // Once applied, the proposal needs a "revert this" checkbox so it can be
  // unwound later. Proposals that started as `proposed` (MERGE, HARVEST) don't
  // get one at render time — add it now.
  if (newState === "applied" && !/^-\s*\[.\]\s+revert this\b/im.test(updated)) {
    updated = updated.replace(/\s*$/, "") + "\n\n- [ ] revert this\n";
  }
  await writeFile(filePath, text.slice(0, sectionStart) + updated + text.slice(sectionEnd), "utf-8");
}

/**
 * Allocate the next sequential ID for a given kind + date.
 * Pass in existing proposals so collisions are avoided.
 */
export function nextProposalId(
  existing: Array<Pick<Proposal, "id" | "kind">>,
  kind: ProposalKind,
  date: Date = new Date(),
): string {
  const stamp = date.toISOString().slice(0, 10);
  const prefix = `PROP-${stamp}-${kind}-`;
  let max = 0;
  for (const p of existing) {
    if (p.id.startsWith(prefix)) {
      const seq = parseInt(p.id.slice(prefix.length), 10);
      if (!Number.isNaN(seq) && seq > max) max = seq;
    }
  }
  return `${prefix}${(max + 1).toString().padStart(3, "0")}`;
}
