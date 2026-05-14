import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

function expandTilde(p: string): string {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : p;
}

const ConfigSchema = z.object({
  vault: z.object({
    path: z.string(),
    embeddings_dir: z.string().optional(),
    ignored_folders: z
      .array(z.string())
      .default([".obsidian", ".trash", "_inbox", "assets", "smart-chats"]),
  }),
  git: z
    .object({
      enabled: z.boolean().default(true),
      remote: z.string().default("origin"),
    })
    .default({ enabled: true, remote: "origin" }),
  inbox: z
    .object({
      dir: z.string().default("_inbox"),
      proposals_file: z.string().default("proposals.md"),
      applied_file: z.string().default("applied.md"),
    })
    .default({ dir: "_inbox", proposals_file: "proposals.md", applied_file: "applied.md" }),
  para: z
    .object({
      buckets: z.array(z.string()).default(["Projects", "Areas", "Resources", "Archives"]),
    })
    .default({ buckets: ["Projects", "Areas", "Resources", "Archives"] }),
  insights: z
    .object({
      top_k: z.number().int().positive().default(20),
      min_similarity: z.number().min(0).max(1).default(0.7),
      min_graph_distance: z.number().int().nonnegative().default(3),
      max_per_report: z.number().int().positive().default(20),
    })
    .default({
      top_k: 20,
      min_similarity: 0.7,
      min_graph_distance: 3,
      max_per_report: 20,
    }),
  llm: z
    .object({
      provider: z.enum(["anthropic"]).default("anthropic"),
      model: z.string().default("claude-sonnet-4-6"),
      api_key_env: z.string().default("ANTHROPIC_API_KEY"),
    })
    .default({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      api_key_env: "ANTHROPIC_API_KEY",
    }),
  harvest: z
    .object({
      // All paths below are relative to vault.path.
      archive_dir: z.string().default("Archives/daily"),
      journal_dir: z.string().default("Journal"),
      fleeting_file: z.string().default("_inbox/fleeting.md"),
      // Daily notes newer than this many days are left alone (still being written).
      cron_buffer_days: z.number().int().nonnegative().default(2),
      // Frontmatter key a note sets to declare itself a journal-genre hub.
      hub_property: z.string().default("vsk-hub"),
    })
    .default({
      archive_dir: "Archives/daily",
      journal_dir: "Journal",
      fleeting_file: "_inbox/fleeting.md",
      cron_buffer_days: 2,
      hub_property: "vsk-hub",
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(filePath: string): Config {
  let absPath = expandTilde(filePath);
  if (!isAbsolute(absPath)) absPath = resolve(process.cwd(), absPath);
  const raw = readFileSync(absPath, "utf-8");
  const parsed = parseYaml(raw);
  const cfg = ConfigSchema.parse(parsed);

  // Resolve vault path
  cfg.vault.path = expandTilde(cfg.vault.path);
  if (!isAbsolute(cfg.vault.path)) {
    cfg.vault.path = resolve(process.cwd(), cfg.vault.path);
  }

  // Resolve embeddings dir (default = inside vault's vault-context plugin)
  if (!cfg.vault.embeddings_dir) {
    cfg.vault.embeddings_dir = resolve(
      cfg.vault.path,
      ".obsidian/plugins/vault-context/embeddings",
    );
  } else {
    cfg.vault.embeddings_dir = expandTilde(cfg.vault.embeddings_dir);
    if (!isAbsolute(cfg.vault.embeddings_dir)) {
      cfg.vault.embeddings_dir = resolve(cfg.vault.path, cfg.vault.embeddings_dir);
    }
  }

  // Resolve inbox dir relative to vault
  if (!isAbsolute(cfg.inbox.dir)) {
    cfg.inbox.dir = resolve(cfg.vault.path, cfg.inbox.dir);
  }

  return cfg;
}

export function getApiKey(cfg: Config): string {
  const key = process.env[cfg.llm.api_key_env];
  if (!key) {
    throw new Error(
      `Missing API key: env var ${cfg.llm.api_key_env} is not set. ` +
        `Set it in your shell or in .env before running vault-sidekick.`,
    );
  }
  return key;
}
