# Architecture

## Design goals

`dsh-3rd-cli-monitor` separates observation from execution. A run is an artifact set owned by a third-party CLI; the monitor is a passive reader with its own durable state. The same application services back the DSH plugin and the standalone CLI.

## Layer boundaries

### Domain

`src/domain/model.mjs` defines the closed run-state and event vocabulary. `src/domain/ports.mjs` documents the small interfaces consumed by the application. `src/domain/redact.mjs` owns bounds and defensive redaction.

The domain has no imports from DSH, ZCode, Node child processes, or a concrete storage implementation.

### Application

`src/application/monitor-service.mjs` coordinates discovery, state transitions, heartbeats, and event emission. It depends on the registry and store ports. It never imports a provider adapter.

`src/application/active-cli.mjs` owns the durable active-adapter selection. Selection changes what is observed, never what is executed.

`src/application/queries.mjs` contains provider-neutral read models shared by the CLI and host surface.

### Adapters

`src/adapters/registry.mjs` is the provider plug point. `src/adapters/zcode/` is the v1 implementation. Each adapter owns path resolution, artifact parsing, and translation into domain snapshots; it does not own scheduling or persistence.

### Infrastructure

`src/storage/file-run-store.mjs` implements status, event, and lock ports. Status is replaced atomically. Events are append-only JSONL with one retained previous generation when the configured size cap is reached. `src/scheduling/` contains the timer and deterministic scheduler ports.

### Composition and host

`src/compose.mjs` is the only production composition root. `src/host/plugin.mjs` adds optional DSH `ctx.provide`, HTTP routes, and Typert registration. Missing optional host services degrade to a working standalone monitor rather than failing DSH boot.

## Data flow

```text
CLI artifacts
    -> provider adapter
        -> normalized RunSnapshot
            -> MonitorService diff
                -> FileRunStore status.json
                -> FileRunStore events.jsonl
                    -> DSH remote / standalone CLI queries
```

## State model

A run is identified by `(cliId, runId)`. `status.json` is the current materialized snapshot. `events.jsonl` is the append-only history. A per-run advisory lock prevents two monitor processes from processing the same run at once; stale locks may be taken over after the configured interval.

Terminal states are not refreshed by heartbeat. Open states receive `run.heartbeat` events and a refreshed `observedAt` value.

## SOLID mapping

- **SRP:** parsers, discovery, scheduling, persistence, queries, and host wiring have separate modules.
- **OCP:** a new CLI implements the adapter contract and is registered without changing the application.
- **LSP:** every registered adapter must provide a stable id and `discoverRuns()` result of normalized snapshots.
- **ISP:** status, event, lock, scheduler, and logger ports are narrow and can be stubbed independently.
- **DIP:** application code depends on ports and injected clocks/schedulers, not concrete providers.

## Bounded observation

The monitor records IDs, states, timestamps, counts, model names, and short diagnostic summaries. It does not copy prompt text, model reasoning, response text, raw tool output, or credentials. File scans and event lists are bounded by explicit limits.

## Extension sequence

1. Add `src/adapters/<cli>/` with a pure discovery/parser implementation.
2. Return only `createRunSnapshot()` values.
3. Register the adapter in `src/compose.mjs` or a host composition override.
4. Add fixture-driven contract tests and an adapter-specific redaction test.
5. Do not add provider imports to `src/domain/` or `src/application/`.
