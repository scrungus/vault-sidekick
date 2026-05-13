import { Command } from "commander";
import { loadConfig } from "./config.js";
import { scanVault, summarise } from "./vault/scanner.js";
import { loadEmbeddings } from "./embeddings/loader.js";
import { refreshMissingEmbeddings } from "./embeddings/embedder.js";
import { runInsights } from "./commands/insights.js";
import { runFullPass } from "./commands/run.js";
import { askClaudeJson } from "./llm/headless.js";

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
  .action(
    async (opts: {
      config: string;
      dryRun?: boolean;
      skipLlm?: boolean;
      skipPush?: boolean;
      maxParaMoves: string;
      maxLinks: string;
      maxMergeCandidates: string;
    }) => {
      const cfg = loadConfig(opts.config);
      await runFullPass(cfg, {
        dryRun: opts.dryRun,
        skipLlm: opts.skipLlm,
        skipPush: opts.skipPush,
        maxParaMoves: parseInt(opts.maxParaMoves, 10),
        maxLinks: parseInt(opts.maxLinks, 10),
        maxMergeCandidates: parseInt(opts.maxMergeCandidates, 10),
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
