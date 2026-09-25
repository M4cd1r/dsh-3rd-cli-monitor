// src/domain/model.mjs — provider-neutral run model.
//
// This module is the shared vocabulary of the monitor. It must stay free of
// DSH and ZCode imports so that future adapters (Claude Code, Cursor,
// OpenCode, Gemini CLI) can adopt it without touching anything here.

import { randomUUID } from 'node:crypto';

/** Every state a run can be observed in. */
export const RUN_STATES = Object.freeze([
  'discovered',
  'running',
  'waiting',
  'response-ready',
  'finished',
  'timed-out',
  'failed',
  'orphaned',
  'unknown',
]);

/** States that still belong to a live (or potentially live) execution. */
export const OPEN_STATES = Object.freeze(['discovered', 'running', 'waiting', 'response-ready']);

/** States after which a run can never change again. */
export const TERMINAL_STATES = Object.freeze(['finished', 'timed-out', 'failed', 'orphaned']);

/** Wire schema tags, bumped on incompatible shape changes. */
export const SNAPSHOT_SCHEMA = 'dsh-3rd-cli-monitor/snapshot@1';
export const EVENT_SCHEMA = 'dsh-3rd-cli-monitor/event@1';

/** The closed set of provider-neutral event types. */
export const EVENT_TYPES = Object.freeze(['run.discovered', 'run.state-changed', 'run.heartbeat']);

export function isValidState(value) {
  return RUN_STATES.includes(value);
}

export function isOpenState(value) {
  return OPEN_STATES.includes(value);
}

export function isTerminalState(value) {
  return TERMINAL_STATES.includes(value);
}

function asIsoOrNull(value) {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function asCount(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * Build a normalized run snapshot. Unknown input fields are dropped: a
 * snapshot carries bounded metadata only, never prompt text, reasoning
 * content, raw tool output, credentials, or unbounded log lines.
 *
 * @param {object} input - raw fields; all optional except runId and cliId.
 * @returns {Readonly<object>} frozen, JSON-serializable snapshot.
 */
export function createRunSnapshot(input = {}) {
  const runId = String(input.runId ?? '');
  if (!runId) throw new TypeError('createRunSnapshot: runId is required');
  const cliId = String(input.cliId ?? '');
  if (!cliId) throw new TypeError('createRunSnapshot: cliId is required');

  const state = isValidState(input.state) ? input.state : 'unknown';
  const counts = input.counts ?? {};
  const logPaths = input.logPaths ?? {};

  return Object.freeze({
    schema: SNAPSHOT_SCHEMA,
    runId,
    cliId,
    state,
    sessionId: typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null,
    slug: typeof input.slug === 'string' ? input.slug.slice(0, 120) : null,
    startedAt: asIsoOrNull(input.startedAt),
    observedAt: asIsoOrNull(input.observedAt ?? new Date()),
    finishedAt: asIsoOrNull(input.finishedAt),
    durationMs: input.durationMs == null ? null : Math.max(0, Math.floor(Number(input.durationMs) || 0)),
    exitKind: typeof input.exitKind === 'string' ? input.exitKind : null,
    errorKind: typeof input.errorKind === 'string' ? input.errorKind.slice(0, 64) : null,
    model: typeof input.model === 'string' ? input.model.slice(0, 120) : null,
    modelsUsed: Object.freeze((Array.isArray(input.modelsUsed) ? input.modelsUsed : [])
      .filter((m) => typeof m === 'string' && m)
      .slice(0, 8)
      .map((m) => m.slice(0, 120))),
    modelVerification: typeof input.modelVerification === 'string' ? input.modelVerification.slice(0, 32) : null,
    responsePresent: input.responsePresent === true,
    counts: Object.freeze({
      modelRequests: asCount(counts.modelRequests),
      modelResponses: asCount(counts.modelResponses),
      emptyResponses: asCount(counts.emptyResponses),
      toolCallsStarted: asCount(counts.toolCallsStarted),
      toolCallsCompleted: asCount(counts.toolCallsCompleted),
      toolCallsFailed: asCount(counts.toolCallsFailed),
      errors: asCount(counts.errors),
      parsedLines: asCount(counts.parsedLines),
      malformedLines: asCount(counts.malformedLines),
    }),
    changedFilesCount: input.changedFilesCount == null ? null : asCount(input.changedFilesCount),
    logPaths: Object.freeze({
      runDir: typeof logPaths.runDir === 'string' ? logPaths.runDir : null,
      report: typeof logPaths.report === 'string' ? logPaths.report : null,
      out: typeof logPaths.out === 'string' ? logPaths.out : null,
      err: typeof logPaths.err === 'string' ? logPaths.err : null,
      rolloutDir: typeof logPaths.rolloutDir === 'string' ? logPaths.rolloutDir : null,
      sessionLog: typeof logPaths.sessionLog === 'string' ? logPaths.sessionLog : null,
    }),
    diagnostics: Object.freeze((Array.isArray(input.diagnostics) ? input.diagnostics : [])
      .filter((d) => typeof d === 'string' && d)
      .slice(0, 10)
      .map((d) => d.slice(0, 200))),
    partialState: typeof input.partialState === 'string' ? input.partialState.slice(0, 500) : null,
  });
}

/**
 * Build a normalized run event. `idGen` is injectable so tests can produce
 * deterministic ids.
 */
export function createRunEvent(input = {}, { idGen = randomUUID } = {}) {
  const type = EVENT_TYPES.includes(input.type) ? input.type : null;
  if (!type) throw new TypeError(`createRunEvent: type must be one of ${EVENT_TYPES.join(', ')}`);
  const runId = String(input.runId ?? '');
  if (!runId) throw new TypeError('createRunEvent: runId is required');
  const cliId = String(input.cliId ?? '');
  if (!cliId) throw new TypeError('createRunEvent: cliId is required');
  const toState = isValidState(input.toState) ? input.toState : null;
  if (!toState) throw new TypeError('createRunEvent: toState must be a valid run state');
  const fromState = input.fromState == null ? null : input.fromState;
  if (fromState !== null && !isValidState(fromState)) {
    throw new TypeError('createRunEvent: fromState must be null or a valid run state');
  }

  return Object.freeze({
    schema: EVENT_SCHEMA,
    id: String(idGen()),
    runId,
    cliId,
    sessionId: typeof input.sessionId === 'string' && input.sessionId ? input.sessionId : null,
    type,
    at: asIsoOrNull(input.at ?? new Date()),
    fromState,
    toState,
    reason: typeof input.reason === 'string' ? input.reason.slice(0, 200) : null,
  });
}

/** Structural fingerprint of the mutable parts of a snapshot. */
export function snapshotFingerprint(snapshot) {
  return JSON.stringify({
    state: snapshot.state,
    sessionId: snapshot.sessionId,
    finishedAt: snapshot.finishedAt,
    durationMs: snapshot.durationMs,
    exitKind: snapshot.exitKind,
    errorKind: snapshot.errorKind,
    model: snapshot.model,
    modelsUsed: snapshot.modelsUsed,
    modelVerification: snapshot.modelVerification,
    responsePresent: snapshot.responsePresent,
    counts: snapshot.counts,
    changedFilesCount: snapshot.changedFilesCount,
    diagnostics: snapshot.diagnostics,
    partialState: snapshot.partialState,
  });
}
