# @m4cd1r/dsh-3rd-cli-monitor

A read-only DeepSeek Harness plugin and CLI for observing third-party coding-CLI runs. Version 1 observes ZCode run artifacts; the application and storage layers are provider-neutral so Claude Code, Cursor, OpenCode, Gemini CLI, and other adapters can be added later.

## What it does

- Discovers existing ZCode wrapper runs from their `out.log`, `err.log`, and `report.json` artifacts.
- Reads ZCode model rollout and session logs as bounded metadata only.
- Normalizes observations into provider-neutral run snapshots and events.
- Stores atomic `status.json` snapshots and bounded append-only `events.jsonl` files.
- Runs the same application code from the DSH host plugin and the standalone CLI.
- Selects one active observation adapter through `activeCli`.
- Exposes optional DSH `ctx.provide`/HTTP/Typert surfaces for status and run history.

## Non-goals

This package deliberately does **not**:

- start, cancel, signal, restart, or otherwise control a third-party CLI;
- send model requests or invoke provider APIs;
- install hooks, skills, or configuration in an external CLI;
- read or persist prompts, reasoning text, credentials, or raw tool output;
- provide a custom WebSocket server in v1;
- treat an active CLI selection as permission to execute that CLI.

The monitor observes artifacts that already exist. A future adapter may expose a setup guide for an external CLI hook, but installation remains an explicit user action.

## Install from source

```sh
git clone https://github.com/M4cd1r/dsh-3rd-cli-monitor.git
cd dsh-3rd-cli-monitor
npm install
npm run verify
```

Install the DSH bundle from the local checkout:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-3rd-cli-monitor
```

The bundle patch is `cordis.patch.yml`. It defaults `activeCli` to `zcode` and does not contain credentials or machine-specific paths.

## Standalone CLI

The CLI shares the same state root as the DSH plugin, so both surfaces observe the same normalized runs:

```sh
dsh-3rd-cli-monitor status --json
dsh-3rd-cli-monitor runs --state running
dsh-3rd-cli-monitor events --run <run-id> --json
dsh-3rd-cli-monitor watch --once
dsh-3rd-cli-monitor use zcode
```

`watch` is the only long-running command. It polls artifacts; it does not launch a CLI. Use `--state-root` to select an alternate monitor state directory.

## Configuration

Resolution order is explicit flags/overrides, then environment, then defaults.

| Setting | Default | Meaning |
|---|---:|---|
| `activeCli` | `zcode` | Registered adapter used for discovery |
| `pollMs` | `15000` | Full discovery cadence |
| `heartbeatMs` | `60000` | Open-run heartbeat cadence |
| `lockStaleMs` | `30000` | Stale per-run lock takeover |
| `stateRoot` | `$DSH_HOME/third-cli-monitor` | Monitor-owned state only |

ZCode paths can be configured with `zcode.logsDirs`, `zcode.rolloutDir`, and `zcode.sessionLogDir`, or with the documented ZCODE/DSH environment variables. See [docs/operations.md](docs/operations.md).

## Architecture

The code follows ports-and-adapters boundaries:

- `src/domain/` — provider-neutral models, state vocabulary, redaction rules, and port contracts.
- `src/application/` — active-CLI selection, polling, heartbeat, queries, and event decisions.
- `src/adapters/` — provider-specific discovery; `zcode/` is the v1 implementation.
- `src/storage/` — atomic snapshots, bounded event generations, and per-run locks.
- `src/host/` — optional DSH service/HTTP/Typert integration.
- `bin/` — standalone CLI composition and commands.

The application depends on interfaces, never on ZCode or DSH. See [docs/architecture.md](docs/architecture.md) and [docs/adapter-contract.md](docs/adapter-contract.md).

## Privacy and safety

The adapter parsers whitelist metadata. Report response text and prompts are reduced to booleans/counters. Log readers cap files, lines, event names, session IDs, model IDs, and free-form diagnostics. The monitor writes only beneath its own state root and never writes to a monitored CLI's directories.

## Development

```sh
npm run check
npm test
npm run verify
```

All shipped source, tests, documentation, and CI annotations are in English. The project is MIT licensed.
