// src/domain/ports.mjs — the ports (interfaces) the application depends on.
//
// These are documentation-only contracts: plain JSDoc descriptions of the
// small surfaces the application layer calls. Concrete implementations live
// in src/storage (durability), src/scheduling (time), and src/adapters
// (provider-specific discovery). Keeping them described here — instead of
// inferred from one concrete class — is what lets a new provider adapter or
// a different store be swapped in without application changes.
//
//  * CliAdapter     — one third-party CLI's read-only observation surface.
//  * RunStore       — durable snapshots (status.json per run).
//  * EventStore     — append-only, bounded run events (events.jsonl).
//  * RunLockManager — per-run mutual exclusion between monitor processes.
//  * Scheduler      — injectable time: poll + heartbeat cadences.
//  * Clock          — injectable "now" for deterministic tests.
//  * Logger         — minimal logging face (info/warn/error).

/**
 * A read-only observation surface for one third-party coding CLI.
 *
 * Implementations MUST be passive: never spawn, signal, cancel, or restart
 * the monitored CLI, and never write inside the CLI's own directories.
 *
 * @interface CliAdapter
 * @property {string} id - stable CLI id, e.g. "zcode" (configuration key for
 *   `activeCli`).
 * @property {string} displayName - human-readable name for reports.
 * @property {(hints?: {nowMs?: number}) => import('./model.mjs').RunSnapshot[]} discoverRuns
 *   Return every run currently discoverable from the CLI's log/report
 *   artifacts, as normalized snapshots. Missing or unreadable artifacts MUST
 *   yield an `unknown`/`unavailable` observation or an empty list — never a
 *   thrown error for expected environmental conditions (no dir yet, partial
 *   file, permissions).
 */

/**
 * Durable, per-run snapshot persistence.
 *
 * @interface RunStore
 * @property {(snapshot: object) => void} writeStatus Replace the run's
 *   status.json atomically (temporary file + rename in the same directory).
 * @property {(cliId: string, runId: string) => object|null} loadStatus
 *   Read the last persisted snapshot, or null when absent/corrupt.
 * @property {{cliId?: string, state?: string, limit?: number}} listRuns
 *   List persisted snapshots, newest first, bounded by `limit`.
 */

/**
 * Append-only bounded event persistence.
 *
 * @interface EventStore
 * @property {(cliId: string, runId: string, events: object[]) => void} appendEvents
 *   Append events as JSONL lines. Implementations bound file growth by
 *   rotating to a single previous generation when a size cap is exceeded.
 * @property {{limit?: number, type?: string, since?: string}} readEvents
 *   Read events oldest-generation-first, newest last, bounded by `limit`.
 */

/**
 * Per-run advisory lock so two monitor processes cannot duplicate work.
 *
 * @interface RunLockManager
 * @property {(cliId: string, runId: string, opts?: {staleMs?: number}) => ({release(): void}|null)} acquire
 *   Return a handle with release(), or null when another live monitor holds
 *   the lock. Locks older than `staleMs` (default 30s) may be taken over.
 */

/**
 * Injectable scheduler. The application asks for two cadences; production
 * binds a timer implementation, tests bind a manual one.
 *
 * @interface Scheduler
 * @property {(ms: number, fn: () => (void|Promise<void>)) => () => void} every
 *   Invoke `fn` every `ms` (no overlapping invocations: the next tick waits
 *   for a previous async `fn`). Returns a stop function.
 * @property {() => void} stopAll Cancel everything this scheduler started.
 */

/**
 * Injectable clock.
 *
 * @interface Clock
 * @property {() => number} now Wall-clock milliseconds.
 */

/**
 * Minimal logger face; every host or embedder supplies its own.
 *
 * @interface Logger
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} error
 */

/** A no-op logger for hosts/tests that have none. */
export const nullLogger = Object.freeze({
  info() {},
  warn() {},
  error() {},
});
