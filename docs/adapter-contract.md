# Adapter Contract

Every provider adapter is a passive observation surface. The application discovers runs through the registry and never imports provider code directly.

## Required surface

```js
class CliAdapter {
  /** Stable configuration key, for example `zcode`. */
  id = '<provider-id>';

  /** Human-readable name for diagnostics. */
  displayName = '<Provider>';

  /**
   * Return normalized snapshots for runs currently visible in artifacts.
   * Missing directories, permissions errors, partial files, and absent
   * sessions are normal environmental conditions: return an empty or
   * `unknown` observation instead of throwing.
   */
  discoverRuns() {
    return [];
  }
}
```

The registry rejects missing ids and duplicate ids. An adapter may expose additional read methods, but the application must not depend on them.

## Normalized snapshot

Use `createRunSnapshot()` from `src/domain/model.mjs`. Required identity fields are `runId` and `cliId`. Unknown states normalize to `unknown`; invalid counts become zero; strings are bounded.

A snapshot may include:

- `state` and terminal metadata;
- `sessionId`, `startedAt`, `observedAt`, and `finishedAt`;
- model names and verification status;
- response presence as a boolean only;
- counts for model requests/responses, tool calls, errors, and malformed lines;
- paths to the run directory and bounded diagnostic sources;
- short diagnostic strings only.

Never put these fields in a snapshot: prompts, response text, reasoning, raw tool output, command contents, environment values, or credentials.

## Normalized event

Use `createRunEvent()`. The v1 event types are:

- `run.discovered`
- `run.state-changed`
- `run.heartbeat`

Events contain only schema, id, run/cli/session identity, timestamp, type, transition states, and a short reason. They are provider-neutral and append-only.

## State mapping

| Provider observation | Domain state |
|---|---|
| A run directory is newly visible | `discovered` |
| Recent artifact activity | `running` |
| Activity is quiet but no terminal report exists | `waiting` |
| A valid report says success | `finished` |
| A valid report says timeout | `timed-out` |
| A valid report says another error | `failed` |
| Run is older than the orphan threshold with no report | `orphaned` |
| Artifacts are unreadable or do not identify a state | `unknown` |

An adapter must not infer `finished` merely because a process handle disappeared. It should use the provider's report/artifact contract when available and report uncertainty as `unknown`.

## Rotation and time windows

The adapter may scan a bounded time window around the run start. It should tolerate a torn final JSONL line and count it as malformed. It must cap the number of files, bytes, sessions, models, and event names it returns.

## ZCode v1 mapping

The ZCode adapter reads:

- wrapper run directories under the configured ZCODE logs directory;
- `report.json` through a whitelist parser;
- `model-io-*.jsonl` rollout files for model request/response metadata;
- `zcode-YYYY-MM-DD.jsonl` session logs for event counters.

The wrapper's `fallbackContext.brief` and response text are never copied. A response is represented only by `responsePresent`.

## Adding a provider

1. Keep provider parsing in `src/adapters/<provider>/`.
2. Return snapshots from the shared factory.
3. Add a fixture that includes missing, partial, and malformed artifacts.
4. Register the adapter in the composition root.
5. Verify that switching `activeCli` changes observation only and cannot launch a process.
