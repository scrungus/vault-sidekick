import {
  App,
  FileSystemAdapter,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { spawn } from "child_process";
import { homedir } from "os";

interface VaultSidekickSettings {
  installPath: string;
  nodeBin: string;
  configPath: string;
}

const DEFAULT_SETTINGS: VaultSidekickSettings = {
  installPath: "~/Documents/code/vault-sidekick",
  nodeBin: "/opt/homebrew/bin/node",
  configPath: "vault-sidekick.config.yaml",
};

export default class VaultSidekickPlugin extends Plugin {
  settings: VaultSidekickSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addCommand({
      id: "run",
      name: "Run full pass",
      callback: () => this.runCli(["run"]),
    });

    this.addCommand({
      id: "run-dry",
      name: "Run (dry-run, no changes)",
      callback: () => this.runCli(["run", "--dry-run"]),
    });

    this.addCommand({
      id: "process-inbox",
      name: "Process inbox (apply ticked checkboxes only)",
      callback: () =>
        this.runCli(["run", "--skip-llm", "--max-links", "0", "--skip-push"]),
    });

    this.addCommand({
      id: "insights",
      name: "Generate daily insights (read-only)",
      callback: () => this.runCli(["insights"]),
    });

    this.addCommand({
      id: "embed-missing",
      name: "Embed missing notes",
      callback: () => this.runCli(["embed-missing"]),
    });

    this.addCommand({
      id: "open-today-insights",
      name: "Open today's insights",
      callback: () => this.openInbox(`daily-insights-${todayStamp()}.md`),
    });

    this.addCommand({
      id: "open-proposals",
      name: "Open proposals",
      callback: () => this.openInbox("proposals.md"),
    });

    this.addSettingTab(new VaultSidekickSettingTab(this.app, this));
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<VaultSidekickSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private expandTilde(p: string): string {
    return p.startsWith("~/") ? p.replace(/^~\//, `${homedir()}/`) : p;
  }

  private async openInbox(filename: string): Promise<void> {
    const path = `_inbox/${filename}`;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice(`Not found: ${path}. Run "vault-sidekick: Run" first.`);
    }
  }

  private runCli(args: string[]): void {
    const installPath = this.expandTilde(this.settings.installPath);
    const nodeBin = this.expandTilde(this.settings.nodeBin);
    const cliPath = `${installPath}/dist/cli.js`;

    const adapter = this.app.vault.adapter;
    const vaultPath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Hint to vault-sidekick where the current vault is (handy if config path
    // is non-standard).
    if (vaultPath) env.VAULT_SIDEKICK_VAULT = vaultPath;

    const label = args.join(" ");
    const notice = new Notice(`vault-sidekick: ${label}…`, 0);

    const child = spawn(nodeBin, [cliPath, ...args, "-c", this.settings.configPath], {
      cwd: installPath,
      env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      notice.hide();
      if (code === 0) {
        new Notice(`vault-sidekick: ${label} done.`, 4000);
        console.log("[vault-sidekick stdout]\n" + stdout);
      } else {
        new Notice(`vault-sidekick: ${label} FAILED (exit ${code}). Check console.`, 8000);
        console.error("[vault-sidekick stderr]\n" + stderr);
        console.error("[vault-sidekick stdout]\n" + stdout);
      }
    });
    child.on("error", (err) => {
      notice.hide();
      new Notice(`vault-sidekick: spawn failed — ${err.message}`, 8000);
    });
  }
}

class VaultSidekickSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: VaultSidekickPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault Sidekick" });
    containerEl.createEl("p", {
      text: "Runs the vault-sidekick CLI from Obsidian's command palette. Output goes to the developer console (View → Toggle Developer Tools).",
    });

    new Setting(containerEl)
      .setName("vault-sidekick install path")
      .setDesc("Directory containing dist/cli.js. ~ expands to your home dir.")
      .addText((text) =>
        text.setValue(this.plugin.settings.installPath).onChange(async (value) => {
          this.plugin.settings.installPath = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Node binary path")
      .setDesc("Absolute path to node. Default works for Homebrew on Apple Silicon.")
      .addText((text) =>
        text.setValue(this.plugin.settings.nodeBin).onChange(async (value) => {
          this.plugin.settings.nodeBin = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Config file")
      .setDesc("Path to vault-sidekick.config.yaml (relative to install path or absolute).")
      .addText((text) =>
        text.setValue(this.plugin.settings.configPath).onChange(async (value) => {
          this.plugin.settings.configPath = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
