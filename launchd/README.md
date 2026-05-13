# launchd nightly job

The plist `com.scrungus.vault-sidekick.plist` schedules `vault-sidekick insights` to run nightly at 03:00 local time, logging to `~/Documents/life/.vault-sidekick/`.

## Install

```sh
# Make sure the build is fresh first
cd ~/Documents/code/vault-sidekick && npm run build

# Create log dir
mkdir -p ~/Documents/life/.vault-sidekick

# Install the launchd plist
cp launchd/com.scrungus.vault-sidekick.plist ~/Library/LaunchAgents/

# Load it (will run at the next 3am)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.scrungus.vault-sidekick.plist
```

## Verify

```sh
launchctl print gui/$(id -u)/com.scrungus.vault-sidekick | head -20
```

## Run on demand (without waiting until 3am)

```sh
launchctl kickstart -k gui/$(id -u)/com.scrungus.vault-sidekick
```

## Uninstall

```sh
launchctl bootout gui/$(id -u)/com.scrungus.vault-sidekick
rm ~/Library/LaunchAgents/com.scrungus.vault-sidekick.plist
```

## Notes

- The plist is a working example with absolute paths. Before loading, edit:
  - `ProgramArguments` — the path to `node` (default `/opt/homebrew/bin/node`) and the path to `dist/cli.js` for your install
  - `WorkingDirectory` — your vault-sidekick repo root
  - `StandardOutPath` / `StandardErrorPath` — log file destinations
- `RunAtLoad` is set to `false` so installing the job does not immediately run it. Use `kickstart` above if you want a manual fire.
- `insights` doesn't need API keys (no LLM calls yet). When Phase 3+ adds LLM-driven proposals, add the relevant env vars to the `EnvironmentVariables` dict.
