import { Command } from "commander";
import { loadConfig } from "./config.js";
import { scanVault, summarise } from "./vault/scanner.js";
import { loadEmbeddings } from "./embeddings/loader.js";
import { refreshMissingEmbeddings } from "./embeddings/embedder.js";
import { runInsights } from "./commands/insights.js";
import { runFullPass } from "./commands/run.js";
import { runHarvest } from "./commands/harvest.js";
import { askClaudeJson } from "./llm/headless.js";
import { Git } from "./git.js";
import { readProposals } from "./proposals/file.js";
import { executeLinkAdd } from "./executors/index.js";
import { join } from "node:path";
import { buildHubRegistry } from "./harvest/hubs.js";

const program = new Command();

program
  .name("vault-sidekick")
  .description("Semi-autonomous Obsidian vault organizer")
  .version("0.1.0");

program
  .command("insights")
  .description("Generate daily insights report (read-only)")
  .option("-c, --config <path>", "path to config file", "vault-sidekick.config.yaml")
  .action(async (opts: { config: string }) => {
    const cfg = loadConfig(opts.config);
    await runInsights(cfg);
  });

program
  .command("run")
  .description("Run the full pass: process inbox → refresh embeds → propose → execute → insights → push")
  .option("-c, --config <path>", "path to config file", "vault-sidekick.config.yaml")
  .option("--dry-run", "print intended actions but do not modify the vault")
  .option("--skip-llm", "only run LINK + insights (no LLM-driven PARA/MERGE)")
  .option("--skip-push", "do not push to origin at the end")
  .option("--max-para-moves <n>", "cap PARA auto-moves this run", "50")
  .option("--max-links <n>", "cap LINK auto-adds this run", "50")
  .option("--max-merge-candidates <n>", "cap MERGE candidates examined", "30")
  .option("--max-harvest <n>", "cap daily notes planned for harvest this run", "0")
  .action(
    async (opts: {
      config: string;
      dryRun?: boolean;
      skipLlm?: boolean;
      skipPush?: boolean;
      maxParaMoves: string;
      maxLinks: string;
      maxMergeCandidates: string;
      maxHarvest: string;
    }) => {
      const cfg = loadConfig(opts.config);
      await runFullPass(cfg, {
        dryRun: opts.dryRun,
        skipLlm: opts.skipLlm,
        skipPush: opts.skipPush,
        maxParaMoves: parseInt(opts.maxParaMoves, 10),
        maxLinks: parseInt(opts.maxLinks, 10),
        maxMergeCandidates: parseInt(opts.maxMergeCandidates, 10),
        maxHarvest: parseInt(opts.maxHarvest, 10),
      });
    },
  );

program
  .command("config")
  .description("Print resolved config (sanity-check your YAML)")
  .option("-c, --config <path>", "path to config file", "vault-sidekick.config.yaml")
  .action(async (opts: { config: string }) => {
    const cfg = loadConfig(opts.config);
    console.log(JSON.stringify(cfg, null, 2));
  });

program
  .command("scan")
  .description("Scan the vault and print stats (read-only, no embeddings)")
  .option("-c, --config <path>", "path to config file", "vault-sidekick.config.yaml")
  .action(async (opts: { config: string }) => {
    const cfg = loadConfig(opts.config);
    const start = Date.now();
    const index = await scanVault({
      vaultPath: cfg.vault.path,
      ignoredFolders: cfg.vault.ignored_folders,
    });
    const stats = summarise(index);
    const elapsed = Date.now() - start;
    console.log(`scanned ${stats.totalNotes} notes in ${elapsed}ms`);
    console.log(JSON.stringify(stats, null, 2));
  });

program
  .command("embed-missing")
  .description("Embed notes that vault-context hasn't indexed yet (uses its OpenAI key)")
  .option("-c, --config <path>", "path to config file", "vault-sidekick.config.yaml")
  .action(async (opts: { config: string }) => {
    const cfg = loadConfig(opts.config);
    const index = await scanVault({
      vaultPath: cfg.vault.path,
      ignoredFolders: cfg.vault.ignored_folders,
    });
    const store = await loadEmbeddings({
      embeddingsDir: cfg.vault.embeddings_dir!,
      knownPaths: index.notes.keys(),
    });
    console.log(`[embed] ${store.missingPaths.length} notes missing embeddings`);
    const result = await refreshMissingEmbeddings({
      vaultPath: cfg.vault.path,
      embeddingsDir: cfg.vault.embeddings_dir!,
      missingPaths: store.missingPaths,
      index,
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("repair-links")
  .description("Make every applied LINK proposal bidirectional (fills in missing reverse links)")
  .option("-c, --config <path>", "path to config file", "vault-sidekick.config.yaml")
  .option("--skip-push", "do not push to origin")
  .action(async (opts: { config: string; skipPush?: boolean }) => {
    const cfg = loadConfig(opts.config);
    const index = await scanVault({
      vaultPath: cfg.vault.path,
      ignoredFolders: cfg.vault.ignored_folders,
    });
    const git = new Git({
      cwd: cfg.vault.path,
      userEmail: process.env.GIT_AUTHOR_EMAIL ?? "vault-sidekick@scrungus",
      userName: process.env.GIT_AUTHOR_NAME ?? "vault-sidekick",
    });
    const ctx = { vaultPath: cfg.vault.path, index, git };
    const proposalsFile = join(cfg.inbox.dir, cfg.inbox.proposals_file);
    const proposals = await readProposals(proposalsFile);
    const links = proposals.filter((p) => p.kind === "LINK" && p.state === "applied");
    console.log(`[repair-links] checking ${links.length} applied LINK proposals`);

    let repaired = 0;
    for (const p of links) {
      if (p.action.op !== "link_add") continue;
      const result = await executeLinkAdd(p.action, ctx, `${p.id}-repair`);
      if (result.commitSha) {
        repaired++;
        console.log(`  ${p.id}: added reverse link (${result.filesAffected.join(", ")})`);
      }
    }
    console.log(`[repair-links] ${repaired} links made bidirectional`);

    if (repaired > 0 && !opts.skipPush && cfg.git.enabled) {
      const ahead = await git.commitsAheadOf(cfg.git.remote, "main");
      if (ahead.length > 0) {
        try {
          await git.push({ remote: cfg.git.remote, branch: "main" });
          console.log(`[repair-links] pushed ${ahead.length} commits`);
        } catch (err) {
          console.warn(`[repair-links] push failed: ${(err as Error).message}`);
        }
      }
    }
  });

program
  .command("harvest")
  .description("Plan daily-note harvests — segment, classify, write HARVEST proposals for review")
  .option("-c, --config <path>", "path to config file", "vault-sidekick.config.yaml")
  .option("--max-dailies <n>", "cap how many daily notes to plan this run")
  .option("--dry-run", "plan but do not write proposals or sidecar files")
  .action(async (opts: { config: string; maxDailies?: string; dryRun?: boolean }) => {
    const cfg = loadConfig(opts.config);
    await runHarvest(cfg, {
      maxDailies: opts.maxDailies ? parseInt(opts.maxDailies, 10) : undefined,
      dryRun: opts.dryRun,
    });
  });

program
  .command("hubs")
  .description("List notes that declare themselves journal-genre hubs (vsk-hub frontmatter)")
  .option("-c, --config <path>", "path to config file", "vault-sidekick.config.yaml")
  .action(async (opts: { config: string }) => {
    const cfg = loadConfig(opts.config);
    const index = await scanVault({
      vaultPath: cfg.vault.path,
      ignoredFolders: cfg.vault.ignored_folders,
    });
    const registry = buildHubRegistry(index, cfg.harvest.hub_tag);
    if (registry.size === 0) {
      console.log(
        `No hub notes found. Tag a note "#${cfg.harvest.hub_tag}/<genre>" (e.g. #${cfg.harvest.hub_tag}/dreams) to designate it.`,
      );
      return;
    }
    console.log(`${registry.size} hub(s) found:`);
    for (const [genre, path] of registry) {
      console.log(`  ${genre} → ${path}`);
    }
  });

program
  .command("ask-claude")
  .description("Smoke-test the headless Claude wrapper. Sends a tiny prompt and prints JSON.")
  .action(async () => {
    const res = await askClaudeJson<{ greeting: string; numbers: number[] }>(
      'Output {"greeting": "hello vault-sidekick", "numbers": [1,2,3]}.',
    );
    console.log(JSON.stringify(res, null, 2));
  });

program
  .command("embeddings")
  .description("Load vault-context embeddings and print stats")
  .option("-c, --config <path>", "path to config file", "vault-sidekick.config.yaml")
  .action(async (opts: { config: string }) => {
    const cfg = loadConfig(opts.config);
    const start = Date.now();
    const index = await scanVault({
      vaultPath: cfg.vault.path,
      ignoredFolders: cfg.vault.ignored_folders,
    });
    const store = await loadEmbeddings({
      embeddingsDir: cfg.vault.embeddings_dir!,
      knownPaths: index.notes.keys(),
    });
    const elapsed = Date.now() - start;
    console.log(`loaded ${store.numNotes} notes / ${store.numChunks} chunks (dim=${store.dim}) in ${elapsed}ms`);
    console.log(`notes without embeddings: ${store.missingPaths.length}`);
    if (store.missingPaths.length > 0 && store.missingPaths.length <= 10) {
      for (const p of store.missingPaths) console.log("  -", p);
    }
  });

program.parseAsync(process.argv);
