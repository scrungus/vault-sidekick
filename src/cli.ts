import { Command } from "commander";
import { loadConfig } from "./config.js";
import { scanVault, summarise } from "./vault/scanner.js";
import { loadEmbeddings } from "./embeddings/loader.js";
import { runInsights } from "./commands/insights.js";

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
  .description("Run the full nightly pass (process inbox → reorg → propose → insights)")
  .option("-c, --config <path>", "path to config file", "vault-sidekick.config.yaml")
  .option("--dry-run", "print intended actions but do not modify the vault")
  .action(async (opts: { config: string; dryRun?: boolean }) => {
    const cfg = loadConfig(opts.config);
    console.log("[run] not yet implemented");
    console.log("[run] vault:", cfg.vault.path, "dry-run:", !!opts.dryRun);
  });

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
