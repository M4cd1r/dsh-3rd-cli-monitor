# Operations

## Install

Build and verify the package first:

```sh
npm install
npm run verify
```

For a local DSH installation, add the checkout as a link bundle:

```sh
dsh plugin --profile web add link:/absolute/path/to/dsh-3rd-cli-monitor
```

The bundle patch is `cordis.patch.yml`. It contains safe defaults only. Put machine-specific paths and credentials in environment variables or a later profile patch layer.

## State and configuration

The default monitor state root is `$DSH_HOME/third-cli-monitor`. It contains only monitor-owned state:

```text
active-cli.json
runs/<cliId>/<runId>/status.json
runs/<cliId>/<runId>/events.jsonl
runs/<cliId>/<runId>/events.1.jsonl
runs/<cliId>/<runId>/.monitor-lock
```

Useful environment variables include:

- `DSH_3RD_CLI_MONITOR_STATE_ROOT` — shared CLI/DSH state root.
- `DSH_3RD_CLI_MONITOR_ZCODE_LOGS` — semicolon/comma-separated wrapper log roots on Windows, colon/comma/semicolon elsewhere.
- `ZCODE_SKILL_LOGS` — fallback wrapper log root honored by the ZCode adapter.
- `ZCODE_DATA_BASE_DIR` — base directory containing `.zcode` CLI data.
- `DSH_HOME` — host home used to derive the default state root.

Explicit host config overrides environment values. See `src/config.mjs` for precedence and validation.

## CLI operations

```sh
dsh-3rd-cli-monitor status --json
dsh-3rd-cli-monitor runs --state running --json
dsh-3rd-cli-monitor events --run <run-id> --json
dsh-3rd-cli-monitor watch --once
dsh-3rd-cli-monitor use <cli-id>
```

`watch --once` performs one discovery pass. A continuous `watch` is passive polling and can be stopped with Ctrl-C. No command in this package starts a third-party CLI.

## DSH surfaces

When optional host services are available, the plugin provides `thirdCliMonitor` and these read routes:

- `GET /dsh-3rd-cli-monitor/status`
- `GET /dsh-3rd-cli-monitor/runs`
- `GET /dsh-3rd-cli-monitor/events`
- `POST /dsh-3rd-cli-monitor/active-cli`

The POST route changes only the adapter selection. Unknown adapter ids return HTTP 400. The Typert remote surface is optional and follows the host's DSH 0.1.7+ compatibility contract; absence of the peer registry does not disable the standalone CLI.

## Interpreting status

- `discovered`: run directory exists, but artifacts are not yet useful.
- `running`: recent log activity is present.
- `waiting`: run is open but quiet.
- `finished`, `failed`, `timed-out`, `orphaned`: terminal observations.
- `unknown`: the report/artifact could not be parsed or did not identify a state.

Heartbeats refresh only open runs. Terminal runs remain quiet.

## Rotation and recovery

Event files are append-only. When the live file reaches the configured cap, it becomes `events.1.jsonl`; the previous previous generation is discarded. Readers return the previous generation followed by the live file, bounded by the requested limit. A torn final line is skipped and counted as malformed.

If a monitor process stops, a `.monitor-lock` file may remain. A later monitor takes it over after `lockStaleMs`. Do not delete a run directory while its CLI is active; the adapter is intentionally read-only.

## Troubleshooting

### No runs discovered

Check the configured ZCode wrapper logs directory, the timestamped run-directory naming, and the `ZCODE_SKILL_LOGS` fallback. Missing directories are a normal empty state.

### Report is unknown

Check the bounded diagnostic string in `status.json` or `dsh-3rd-cli-monitor runs`. Do not paste raw report/log contents into chat; they may contain prompts or responses.

### Active CLI changed but no data appears

Verify the id is registered and that its adapter's artifact paths are configured. `use` changes observation only; it does not start the selected CLI.

## Safety and privacy

The monitor never installs external hooks, sends model requests, controls processes, or writes to a provider's data directories. Raw prompts, model reasoning, tool output, and credentials are not part of the normalized state contract.
