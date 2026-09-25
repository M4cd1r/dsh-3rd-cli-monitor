// test/helpers/fixtures.mjs — hermetic builders for wrapper-style artifacts.
//
// Everything is written into a per-test temp directory; mtimes are set
// explicitly so time-based behavior (running/waiting/orphaned, scan windows)
// is deterministic under a fake clock.

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Content markers used by redaction assertions. */
export const SAMPLE_PROMPT = 'SECRET-PROMPT-MARKER-7f3a: deploy the flux capacitor to sector 9';
export const SAMPLE_RESPONSE = 'SECRET-RESPONSE-MARKER-2b8c: all systems nominal, capacitor deployed';
export const SAMPLE_REASONING = 'SECRET-REASONING-MARKER-9d1e: the user clearly wants …';

/** Wrapper-style run dir stamp: ISO with ':' and '.' replaced by '-'. */
export function stampIso(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/** Create a unique temp root and register cleanup with the test context. */
export function makeTempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-3rd-cli-monitor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fixed clock the test drives by hand. */
export function fakeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
      return now;
    },
    get nowMs() {
      return now;
    },
  };
}

/**
 * Write one wrapper run directory.
 * @param {object} opts
 * @param {number} opts.startedMs - run start (used for the dir name stamp).
 * @param {string} [opts.slug]
 * @param {object|null} [opts.report] - object written as report.json, or
 *   null to skip the file (unfinished run), or 'garbage' for invalid JSON.
 * @param {string} [opts.outText] - content for out.log.
 * @param {string} [opts.errText] - content for err.log.
 * @param {number} [opts.mtimeMs] - mtime applied to written files.
 * @param {string} [opts.logsDir] - parent logs directory.
 */
export function writeRunDir(logsDir, opts) {
  const startedMs = opts.startedMs;
  const slug = opts.slug ?? 'brief';
  const runDir = join(logsDir, `${stampIso(startedMs)}-${slug}`);
  mkdirSync(runDir, { recursive: true });
  if (opts.outText !== undefined) writeFileSync(join(runDir, 'out.log'), opts.outText);
  if (opts.errText !== undefined) writeFileSync(join(runDir, 'err.log'), opts.errText);
  if (opts.report === 'garbage') writeFileSync(join(runDir, 'report.json'), '{"status": torn');
  else if (opts.report !== undefined && opts.report !== null) {
    writeFileSync(join(runDir, 'report.json'), JSON.stringify(opts.report, null, 2));
  }
  if (opts.mtimeMs !== undefined) {
    const stamp = new Date(opts.mtimeMs);
    utimesSync(runDir, stamp, stamp);
    for (const name of ['out.log', 'err.log', 'report.json']) {
      try {
        utimesSync(join(runDir, name), stamp, stamp);
      } catch {
        // file not written for this run
      }
    }
  }
  return runDir;
}

/** A realistic wrapper report — including the sensitive fields the monitor must never persist. */
export function baseReport(overrides = {}) {
  return {
    status: 'ok',
    errorKind: null,
    model: 'GLM-5.3-Flash',
    modelActual: 'GLM-5.3-Flash',
    modelPinChanged: null,
    modelReasoningLevel: 'max',
    modelsUsed: ['GLM-5.3-Flash'],
    modelVerification: 'ok',
    rolloutFilesScanned: 1,
    response: SAMPLE_RESPONSE,
    durationMs: 65_535,
    changedFiles: ['M src/a.js', 'A src/b.js'],
    plan: 'C:/briefs/my-plan.md',
    sessionDiagnostics: {
      collectedAt: '2026-09-24T09:45:00.000Z',
      rollout: {
        dir: 'C:/Users/x/.zcode/cli/rollout',
        files: [{ name: 'model-io-sess_abc.jsonl', bytes: 10, requests: 5, responses: 5, emptyResponses: 1, malformed: 0 }],
      },
      sessionLog: {
        dir: 'C:/Users/x/.zcode/cli/log',
        activity: { modelRequestCompleted: 5, toolCallCompleted: 7, toolCallFailed: 1, errors: 2 },
      },
    },
    gitBefore: [],
    gitAfter: ['M src/a.js', 'A src/b.js'],
    fallbackContext: {
      brief: SAMPLE_PROMPT,
      partialState: null,
      logRefs: { out: 'C:/logs/run/out.log', err: 'C:/logs/run/err.log', rollout: 'C:/u/.zcode/cli/rollout', sessionLog: null },
    },
    ...overrides,
  };
}

/** Append model-io entries to the rollout dir (entries: {atMs, model, empty?, sessionId?}). */
export function writeRolloutEntries(rolloutDir, sessionId, entries, { fileName } = {}) {
  mkdirSync(rolloutDir, { recursive: true });
  const name = fileName ?? `model-io-${sessionId}.jsonl`;
  const lines = entries.map((e) => JSON.stringify({
    startedAt: new Date(e.atMs).toISOString(),
    sessionId: e.sessionId ?? sessionId,
    request: { body: { model: e.model } },
    response: e.empty ? {} : { text: SAMPLE_RESPONSE, toolCalls: e.toolCalls ?? [] },
  }));
  appendFileSync(join(rolloutDir, name), lines.join('\n') + '\n');
}

/** Append session-log events (zcode-<date>.jsonl). */
export function writeSessionEvents(sessionLogDir, atMs, events) {
  mkdirSync(sessionLogDir, { recursive: true });
  const date = new Date(atMs).toISOString().slice(0, 10);
  const lines = events.map((e) => JSON.stringify({
    timestamp: new Date(e.atMs ?? atMs).toISOString(),
    sessionId: e.sessionId,
    event: e.event,
    ...(e.level ? { level: e.level } : {}),
  }));
  appendFileSync(join(sessionLogDir, `zcode-${date}.jsonl`), lines.join('\n') + '\n');
}
