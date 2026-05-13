#!/usr/bin/env bash
# vault-sidekick installer.
#
# Usage:
#   bash install.sh [--vault PATH] [--skills] [--plugin] [--launchd]
#
#   --vault PATH   Pre-fill the vault path in the generated config. Required
#                  if you also pass --skills, --plugin, or --launchd.
#   --skills       Also install kepano/obsidian-skills into <vault>/.claude/skills/.
#   --plugin       Also build and install the Obsidian command-palette plugin.
#   --launchd      Also install + load the macOS launchd nightly job at 03:00.
#
# Env overrides:
#   VAULT_SIDEKICK_DIR   Where to clone vault-sidekick (default: ~/Documents/code/vault-sidekick).
#   VAULT_SIDEKICK_REPO  Source repo URL (default: https://github.com/scrungus/vault-sidekick).
#
# Re-running this script is safe — it skips work that's already done.

set -euo pipefail

REPO_URL="${VAULT_SIDEKICK_REPO:-https://github.com/scrungus/vault-sidekick}"
INSTALL_DIR="${VAULT_SIDEKICK_DIR:-$HOME/Documents/code/vault-sidekick}"
VAULT_PATH=""
INSTALL_SKILLS=0
INSTALL_LAUNCHD=0
INSTALL_PLUGIN=0

say()  { printf "\033[34m[vault-sidekick]\033[0m %s\n" "$*"; }
warn() { printf "\033[33m[vault-sidekick]\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[31m[vault-sidekick]\033[0m %s\n" "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vault)     VAULT_PATH="$2"; shift 2 ;;
    --vault=*)   VAULT_PATH="${1#*=}"; shift ;;
    --skills)    INSTALL_SKILLS=1; shift ;;
    --plugin)    INSTALL_PLUGIN=1; shift ;;
    --launchd)   INSTALL_LAUNCHD=1; shift ;;
    -h|--help)
      sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown flag: $1 (try --help)" ;;
  esac
done

# Expand ~ in VAULT_PATH (the shell only expands it when unquoted at parse time).
if [[ -n "$VAULT_PATH" ]]; then
  VAULT_PATH="${VAULT_PATH/#\~/$HOME}"
fi

# --- Prereqs ---------------------------------------------------------------

command -v node >/dev/null || die "node not found — install Node ≥ 20 first (https://nodejs.org)"
command -v npm  >/dev/null || die "npm not found"
command -v git  >/dev/null || die "git not found"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node ≥ 20 required (have v$(node -p 'process.versions.node'))"

# --- Clone or reuse --------------------------------------------------------

if [[ -f "$PWD/package.json" ]] && grep -q '"name": *"vault-sidekick"' "$PWD/package.json" 2>/dev/null; then
  say "Running from existing vault-sidekick checkout at $PWD"
  INSTALL_DIR="$PWD"
elif [[ -d "$INSTALL_DIR/.git" ]]; then
  say "Updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  say "Cloning $REPO_URL → $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# --- Build -----------------------------------------------------------------

say "Installing dependencies"
npm install --silent

say "Building"
npm run build >/dev/null

# --- Config ----------------------------------------------------------------

CONFIG_FILE="$INSTALL_DIR/vault-sidekick.config.yaml"
if [[ -f "$CONFIG_FILE" ]]; then
  say "Config already at $CONFIG_FILE — leaving it alone"
else
  cp vault-sidekick.config.example.yaml "$CONFIG_FILE"
  if [[ -n "$VAULT_PATH" ]]; then
    sed "s|path: ~/path/to/your/vault|path: $VAULT_PATH|" "$CONFIG_FILE" > "$CONFIG_FILE.tmp"
    mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
    say "Wrote $CONFIG_FILE with vault.path=$VAULT_PATH"
  else
    warn "Wrote $CONFIG_FILE with placeholder vault.path — edit it before running."
  fi
fi

# --- Skills (optional) -----------------------------------------------------

if [[ "$INSTALL_SKILLS" -eq 1 ]]; then
  [[ -n "$VAULT_PATH" ]] || die "--skills requires --vault"
  [[ -d "$VAULT_PATH" ]] || die "vault not found at $VAULT_PATH"

  SKILLS_DIR="$VAULT_PATH/.claude/skills"
  mkdir -p "$SKILLS_DIR"

  TMP_KEPANO="$(mktemp -d)"
  trap 'rm -rf "$TMP_KEPANO"' EXIT
  say "Fetching kepano/obsidian-skills"
  git clone --depth 1 --quiet https://github.com/kepano/obsidian-skills "$TMP_KEPANO/repo"

  for skill in obsidian-markdown obsidian-cli; do
    if [[ -d "$SKILLS_DIR/$skill" ]]; then
      say "  $skill already installed — skipping"
    else
      cp -r "$TMP_KEPANO/repo/skills/$skill" "$SKILLS_DIR/"
      say "  installed $skill → $SKILLS_DIR/$skill"
    fi
  done
fi

# --- Obsidian plugin (optional) --------------------------------------------

if [[ "$INSTALL_PLUGIN" -eq 1 ]]; then
  [[ -n "$VAULT_PATH" ]] || die "--plugin requires --vault"
  [[ -d "$VAULT_PATH" ]] || die "vault not found at $VAULT_PATH"

  PLUGIN_SRC="$INSTALL_DIR/obsidian-plugin"
  PLUGIN_DEST="$VAULT_PATH/.obsidian/plugins/vault-sidekick"

  if [[ ! -f "$PLUGIN_SRC/main.js" ]]; then
    say "Building Obsidian plugin"
    (cd "$PLUGIN_SRC" && npm install --silent && npm run build >/dev/null)
  fi

  mkdir -p "$PLUGIN_DEST"
  cp "$PLUGIN_SRC/main.js" "$PLUGIN_DEST/main.js"
  cp "$PLUGIN_SRC/manifest.json" "$PLUGIN_DEST/manifest.json"
  say "Installed Obsidian plugin → $PLUGIN_DEST"
  say "  Enable it in Obsidian: Settings → Community plugins → Vault Sidekick"
fi

# --- Launchd (optional, macOS) ---------------------------------------------

if [[ "$INSTALL_LAUNCHD" -eq 1 ]]; then
  [[ "$(uname -s)" == "Darwin" ]] || die "--launchd is macOS only"
  command -v launchctl >/dev/null || die "launchctl not found"
  [[ -n "$VAULT_PATH" ]] || die "--launchd requires --vault"

  NODE_BIN="$(command -v node)"
  NODE_DIR="$(dirname "$NODE_BIN")"
  PLIST_TEMPLATE="$INSTALL_DIR/launchd/com.scrungus.vault-sidekick.plist.template"
  PLIST_DEST="$HOME/Library/LaunchAgents/com.scrungus.vault-sidekick.plist"

  [[ -f "$PLIST_TEMPLATE" ]] || die "plist template not found: $PLIST_TEMPLATE"

  mkdir -p "$HOME/Library/LaunchAgents"
  mkdir -p "$VAULT_PATH/.vault-sidekick"

  sed \
    -e "s|{{NODE_BIN}}|$NODE_BIN|g" \
    -e "s|{{NODE_DIR}}|$NODE_DIR|g" \
    -e "s|{{INSTALL_DIR}}|$INSTALL_DIR|g" \
    -e "s|{{VAULT_PATH}}|$VAULT_PATH|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DEST"

  # If already loaded, unload first so the new plist takes effect.
  launchctl bootout "gui/$(id -u)/com.scrungus.vault-sidekick" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"
  say "launchd job installed → $PLIST_DEST"
  say "  scheduled: 03:00 daily. Logs: $VAULT_PATH/.vault-sidekick/launchd.{out,err}.log"
  say "  fire now: launchctl kickstart -k gui/\$(id -u)/com.scrungus.vault-sidekick"
fi

# --- Done ------------------------------------------------------------------

say ""
say "Done."
say ""
if [[ -z "$VAULT_PATH" ]]; then
  say "Next: edit $CONFIG_FILE, then run:"
else
  say "Try it:"
fi
say "  cd $INSTALL_DIR && node dist/cli.js insights"
