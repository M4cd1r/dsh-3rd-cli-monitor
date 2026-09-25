# DSH Skill: Third-Party CLI Monitor

Use this skill when you need to inspect an existing coding-CLI run without starting a second run. It is a read-only observation workflow.

## Safety boundary

**Never start, cancel, signal, restart, or configure a third-party CLI through this skill.** Do not install external hooks automatically. Do not send a model request. The monitor may only read the CLI's existing log/report artifacts and write its own bounded state.

## Workflow

1. Choose or inspect the active observation adapter:

   ```sh
   dsh-3rd-cli-monitor use <registered-cli-id>
   dsh-3rd-cli-monitor status --json
   ```

2. Inspect the current aggregate without creating a run:

   ```sh
   dsh-3rd-cli-monitor runs --json
   ```

3. For a known run, inspect normalized events:

   ```sh
   dsh-3rd-cli-monitor events --run <run-id> --json
   ```

4. For a live observation, use `watch --once` for one discovery pass or `watch` for bounded polling. The monitor never launches the observed CLI.

5. Interpret states conservatively:
   - `running` means recent artifact activity was observed.
   - `waiting` means a run directory exists but activity is quiet.
   - `discovered` means the run has been seen but no useful artifact activity is available yet.
   - `finished`, `failed`, `timed-out`, and `orphaned` are terminal observations.
   - `unknown` means the available report/artifact was unreadable or did not identify a state.

## Provider neutrality

The application knows only the normalized run/event contract. If a future CLI is not registered, report that as unavailable; do not add ad-hoc parsing in the application layer. A new provider belongs in `src/adapters/<provider>/` and must satisfy the contract in `docs/adapter-contract.md`.

## DSH integration

The DSH host exposes the same read models through `thirdCliMonitor` and the optional `/dsh-3rd-cli-monitor/*` routes. A client may poll status; v1 intentionally has no custom WebSocket transport.

## Troubleshooting

If status is empty, verify the configured CLI log directories and that the run has a wrapper-style timestamped directory. If a run is `unknown`, inspect the bounded diagnostic strings; never dump raw logs into the conversation. If rotation removed older events, use the current and previous JSONL generation only.
