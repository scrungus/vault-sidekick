# vault-sidekick

A semi-autonomous organizer for [Obsidian](https://obsidian.md) vaults.

vault-sidekick runs nightly (or on demand) and surfaces the connections, duplicates, and gaps in your knowledge base that you'd never spot by browsing folders. It writes everything to a human-reviewable inbox; destructive operations require a checkbox before they run.

> **Status:** Phase 2 of 4. The read-only `insights` command is shipped. Proposal-driven moves, merges, and PARA classification land in subsequent phases.

## What it does today

```sh
vault-sidekick insights
```

For each note in your vault, vault-sidekick picks an informative representative chunk, finds the top-K semantically nearest chunks from other notes, computes the graph distance between them (BFS over wikilinks), and reports pairs where:

- semantic similarity is high (≥ 0.7 by default)
- graph distance is also high (≥ 3 hops, or unreachable)

These are the notes that *should* be connected — same idea, never linked. The result lands in `_inbox/daily-insights-YYYY-MM-DD.md` inside your vault with [graphify](https://github.com/safishamsi/graphify)-style confidence tags (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`).

Other commands available now:

| Command | Use it for |
| --- | --- |
| `vault-sidekick config` | Print the resolved config (sanity-check your YAML) |
| `vault-sidekick scan` | Walk the vault and report note count / link health / tag stats |
| `vault-sidekick embeddings` | Load vault-context embeddings into Orama and print stats |

## Phases ahead

- **Phase 3** — proposals + non-destructive auto-execution. Moves, renames, link-adds, and tag-adds run automatically (committed to git per-operation); merges, deletes, and body rewrites queue in `_inbox/proposals.md` until you tick the checkbox.
- **Phase 4** — first big bootstrap run on an unorganized vault. Same code path as nightly, just produces a much bigger proposal queue to triage.

## Requirements

- Node ≥ 20
- An Obsidian vault
- The [vault-context](https://github.com/scrungus/vault-context) plugin installed and indexed — vault-sidekick consumes its embedding JSON files directly. (Open Obsidian once before the first run so embeddings exist.)
- Optional: git initialized inside the vault for per-operation commits and rollback.

## Install

```sh
git clone https://github.com/scrungus/vault-sidekick
cd vault-sidekick
npm install
npm run build
cp vault-sidekick.config.example.yaml vault-sidekick.config.yaml
$EDITOR vault-sidekick.config.yaml   # set vault.path
node dist/cli.js insights
```

To install globally: `npm link` from the repo root, then `vault-sidekick <cmd>` from anywhere.

## Configuration

See `vault-sidekick.config.example.yaml` for the full schema with comments. The minimum:

```yaml
vault:
  path: ~/path/to/your/vault
```

All other fields have defaults. Notable knobs:

- `insights.min_similarity` — cosine similarity floor (default 0.7). Raise to filter noise; lower to widen the net.
- `insights.min_graph_distance` — BFS-hop floor (default 3). Lower to surface near-misses; raise to focus on truly disconnected pairs.
- `vault.ignored_folders` — folders the scanner skips. Defaults exclude `.obsidian`, `.trash`, `_inbox`, `assets`, `smart-chats`.

## Nightly cron (macOS launchd)

```sh
cp launchd/com.scrungus.vault-sidekick.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.scrungus.vault-sidekick.plist
```

See [`launchd/README.md`](./launchd/README.md) for verify/uninstall/kickstart.

## Design

- **No separate embedding pipeline.** vault-sidekick reads vault-context's on-disk embedding JSONs and bundles `@orama/orama` to run vector search in Node. New notes that haven't been indexed by Obsidian yet are flagged, not silently dropped.
- **No mocked LLM cost.** `insights` is pure local search — no API calls. LLM reasoning enters in Phase 3+ for classification and proposal narration.
- **Per-operation git commits inside the vault.** Phase 3+ will commit each move/rename/link-edit as its own commit so you can `git revert` any single change.
- **Approval through Obsidian, not the terminal.** Destructive proposals land in a markdown file inside your vault with checkboxes. You tick them in Obsidian; the next cron run applies them.

## Reused work

- [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) — the agent skills for producing Obsidian-flavored markdown and driving the obsidian CLI. Install them into `.claude/skills/` in your vault.
- [karpathy LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) — the Ingest/Query/Lint loop framing and the `log.md` artifact pattern.
- [safishamsi/graphify](https://github.com/safishamsi/graphify) — the `GRAPH_REPORT.md` output shape and the `EXTRACTED` / `INFERRED` / `AMBIGUOUS` edge-confidence tags.
- [tobi/qmd](https://github.com/tobi/qmd) — the MCP tool surface (`query` / `get` / `multi_get` / `status`) and `--explain` audit pattern that future versions will adopt.

## License

MIT.
