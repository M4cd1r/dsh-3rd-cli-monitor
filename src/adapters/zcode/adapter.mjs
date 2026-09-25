// src/adapters/zcode/adapter.mjs — the ZCode CliAdapter.
//
// Composes the discovery, report parsing, and the two log scanners into
// normalized run snapshots. The adapter is strictly passive: it reads files
// and their mtimes, and never spawns, signals, or writes anything inside the
// wrapper's or the CLI's directories.
//
// State mapping (documented in docs/adapter-contract.md):
//   report.json present:
//     status "ok"                          -> finished
//     errorKind "timeout"                  -> timed-out
//     other errorKind                      -> failed
//     anything else / unparsable report    -> unknown
//   report.json absent (run still open):
//     age > orphanAfterMs (35 min: the wrapper caps runs at 30)  -> orphaned
//     log write within runningFreshMs (2 min)                    -> running
//     otherwise                                                  -> waiting
//     no out.log/err.log at all yet                              -> discovered

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRunSnapshot } from '../../domain/model.mjs';
import { boundStringList } from '../../domain/redact.mjs';
import { ZcodeReportParser } from './report-parser.mjs';
import { ZcodeRolloutScanner } from './rollout-scanner.mjs';
import { ZcodeSessionLogScanner } from './session-log-scanner.mjs';
import {
  parseRunDirName,
  resolveDataRoot,
  resolveLogsDirs,
  rolloutDirFor,
  sessionLogDirFor,
} from './paths.mjs';

export const ZCODE_CLI_ID = 'zcode';

const RUNNING_FRESH_MS = 120_000;
const ORPHAN_AFTER_MS = 35 * 60_000; // 30-minute wrapper cap + slack

/**
 * Default adapter configuration, resolved from the environment the wrapper
 * itself honors. All timestamps in ms.
 */
export function resolveZcodeAdapterConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const homedir = opts.homedir;
  const dataRoot = opts.dataRoot ?? resolveDataRoot({ env, homedir });
  return {
    logsDirs: resolveLogsDirs({ env, homedir, logsDirs: opts.logsDirs }),
    rolloutDir: opts.rolloutDir ?? rolloutDirFor(dataRoot),
    sessionLogDir: opts.sessionLogDir ?? sessionLogDirFor(dataRoot),
    runningFreshMs: opts.runningFreshMs ?? RUNNING_FRESH_MS,
    orphanAfterMs: opts.orphanAfterMs ?? ORPHAN_AFTER_MS,
  };
}

export class ZcodeCliAdapter {
  id = ZCODE_CLI_ID;
  displayName = 'ZCode';

  /**
   * @param {object} [opts]
   * @param {{now: () => number}} [opts.clock]
   * @param {string|string[]} [opts.logsDirs] wrapper run-log directories.
   * @param {string} [opts.rolloutDir] ZCode rollout directory.
   * @param {string} [opts.sessionLogDir] ZCode session log directory.
   * @param {string} [opts.dataRoot] ZCode CLI data root (~/.zcode by default).
   * @param {number} [opts.runningFreshMs]
   * @param {number} [opts.orphanAfterMs]
   * @param {{env?: object, homedir?: string}} [opts.resolve] environment for discovery.
   */
  constructor(opts = {}) {
    const resolved = resolveZcodeAdapterConfig({
      logsDirs: opts.logsDirs,
      rolloutDir: opts.rolloutDir,
      sessionLogDir: opts.sessionLogDir,
      dataRoot: opts.dataRoot,
      runningFreshMs: opts.runningFreshMs,
      orphanAfterMs: opts.orphanAfterMs,
      env: opts.resolve?.env ?? process.env,
      homedir: opts.resolve?.homedir,
    });
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.logsDirs = resolved.logsDirs;
    this.runningFreshMs = resolved.runningFreshMs;
    this.orphanAfterMs = resolved.orphanAfterMs;
    this.reportParser = new ZcodeReportParser();
    this.rolloutScanner = new ZcodeRolloutScanner({ rolloutDir: resolved.rolloutDir });
    this.sessionLogScanner = new ZcodeSessionLogScanner({ sessionLogDir: resolved.sessionLogDir });
  }

  /**
   * Discover every run visible in the configured wrapper logs directories.
   * Missing directories yield an empty list — an environmental condition,
   * never a failure.
   * @returns {object[]}
   */
  discoverRuns() {
    const nowMs = this.clock.now();
    const found = [];
    for (const dir of this.logsDirs) {
      found.push(...this._scanLogsDir(dir, nowMs));
    }
    found.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    return found;
  }

  _scanLogsDir(logsDir, nowMs) {
    let entries;
    try {
      entries = readdirSync(logsDir, { withFileTypes: true });
    } catch {
      return []; // no logs dir yet (or unreadable): fail safe, no boot impact
    }
    const runs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const parsed = parseRunDirName(entry.name);
      if (!parsed) continue;
      const runDir = join(logsDir, entry.name);
      const reportPath = join(runDir, 'report.json');
      if (existsSync(reportPath)) {
        runs.push(this._observeFromReport(runDir, reportPath, parsed, nowMs));
      } else {
        runs.push(this._observeLive(runDir, parsed, nowMs));
      }
    }
    return runs;
  }

  _observeFromReport(runDir, reportPath, { stamp, slug, startedMs }, nowMs) {
    const report = this.reportParser.parse(reportPath);
    const outLog = join(runDir, 'out.log');
    const errLog = join(runDir, 'err.log');
    const base = {
      runId: `${stamp}-${slug}`,
      cliId: this.id,
      slug,
      startedAt: new Date(startedMs).toISOString(),
      observedAt: new Date(nowMs).toISOString(),
      logPaths: {
        runDir,
        report: reportPath,
        out: existsSync(outLog) ? outLog : null,
        err: existsSync(errLog) ? errLog : null,
        rolloutDir: this.rolloutScanner.rolloutDir,
        sessionLog: null,
      },
    };
    if (!report.ok) {
      return createRunSnapshot({
        ...base,
        state: 'unknown',
        diagnostics: [`report: ${report.reason}`],
      });
    }
    const meta = report.meta;
    const state = this._stateFromReport(meta);
    const diag = this._reportDiagnostics(meta);
    return createRunSnapshot({
      ...base,
      state,
      finishedAt: new Date(nowMs).toISOString(),
      durationMs: meta.durationMs,
      exitKind: meta.status,
      errorKind: meta.errorKind,
      model: meta.model,
      modelsUsed: meta.modelsUsed,
      modelVerification: meta.modelVerification,
      responsePresent: meta.responsePresent,
      changedFilesCount: meta.changedFilesCount,
      counts: this._countsFromReportDiag(meta.diag),
      diagnostics: diag,
      partialState: meta.partialState,
    });
  }

  _stateFromReport(meta) {
    if (meta.status === 'ok') return 'finished';
    if (meta.errorKind === 'timeout') return 'timed-out';
    if (meta.errorKind) return 'failed';
    return 'unknown';
  }

  _countsFromReportDiag(diag) {
    if (!diag) return {};
    return {
      modelRequests: diag.requests,
      modelResponses: diag.responses - diag.emptyResponses,
      emptyResponses: diag.emptyResponses,
      toolCallsCompleted: diag.toolCallsCompleted,
      toolCallsFailed: diag.toolCallsFailed,
      errors: diag.errors,
      malformedLines: diag.malformed,
    };
  }

  _reportDiagnostics(meta) {
    const lines = [];
    lines.push(`report: status=${meta.status}${meta.errorKind ? ` errorKind=${meta.errorKind}` : ''}` +
      `${meta.modelVerification ? ` verification=${meta.modelVerification}` : ''}`);
    lines.push(`response: ${meta.responsePresent ? 'present (text not stored)' : 'absent'}`);
    if (meta.diag) {
      lines.push('wrapper diagnostics: rollout files=' + meta.diag.rolloutFiles +
        ` requests=${meta.diag.requests} empty=${meta.diag.emptyResponses}` +
        ` sessionEvents: modelCompleted=${meta.diag.modelRequestsCompleted}` +
        ` toolCompleted=${meta.diag.toolCallsCompleted} toolFailed=${meta.diag.toolCallsFailed}` +
        ` errors=${meta.diag.errors}`);
    }
    if (meta.planFile) lines.push(`plan: ${meta.planFile}`);
    return lines;
  }

  _observeLive(runDir, { stamp, slug, startedMs }, nowMs) {
    const outLog = join(runDir, 'out.log');
    const errLog = join(runDir, 'err.log');
    const logs = [];
    for (const [label, path] of [['out.log', outLog], ['err.log', errLog]]) {
      try {
        const stat = statSync(path);
        logs.push({ label, path, bytes: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // not written yet
      }
    }
    const lastActivityMs = logs.reduce((acc, log) => Math.max(acc, log.mtimeMs), 0);
    const ageMs = nowMs - startedMs;
    const quietMs = lastActivityMs ? nowMs - lastActivityMs : null;

    const rollout = this.rolloutScanner.scan({ sinceMs: startedMs });
    const singleSession = rollout.sessionIds.length === 1 ? rollout.sessionIds[0] : null;
    const sessionLog = this.sessionLogScanner.scan({
      sinceMs: startedMs,
      sessionIds: rollout.sessionIds.length > 0 ? rollout.sessionIds : [],
    });

    let state;
    const diag = [];
    if (ageMs > this.orphanAfterMs) {
      state = 'orphaned';
      diag.push(`no report.json after ${Math.round(ageMs / 60_000)} min; exceeds the wrapper's 30-minute cap — supervisor likely gone`);
    } else if (logs.length > 0 && quietMs !== null && quietMs <= this.runningFreshMs) {
      state = 'running';
    } else if (logs.length > 0) {
      state = 'waiting';
    } else {
      state = 'discovered';
    }

    if (logs.length > 0) {
      diag.push(quietMs === null
        ? `no report.json yet; last log write unknown`
        : `no report.json yet; last log write ${Math.round(quietMs / 1000)}s ago`);
    } else {
      diag.push('run directory seen; out.log/err.log not written yet');
    }
    diag.push(rollout.available
      ? `rollout window: requests=${rollout.totals.requests} empty=${rollout.totals.emptyResponses} malformed=${rollout.totals.malformed}`
      : 'rollout log unavailable');
    if (rollout.sessionIds.length > 1) diag.push(`ambiguous session ids in window (${rollout.sessionIds.length}) — session not attributed`);
    if (sessionLog.available) {
      diag.push(`session events: modelCompleted=${sessionLog.activity.modelRequestCompleted}` +
        ` toolCompleted=${sessionLog.activity.toolCallCompleted}` +
        ` toolFailed=${sessionLog.activity.toolCallFailed} errors=${sessionLog.activity.errors}`);
    }

    const sessionLogPath = sessionLog.files[0] ? join(sessionLog.dir, sessionLog.files[0].name) : null;
    return createRunSnapshot({
      runId: `${stamp}-${slug}`,
      cliId: this.id,
      slug,
      state,
      sessionId: singleSession,
      startedAt: new Date(startedMs).toISOString(),
      observedAt: new Date(nowMs).toISOString(),
      counts: {
        modelRequests: rollout.totals.requests,
        modelResponses: rollout.totals.responses - rollout.totals.emptyResponses,
        emptyResponses: rollout.totals.emptyResponses,
        toolCallsStarted: sessionLog.activity.toolCallStarted,
        toolCallsCompleted: sessionLog.activity.toolCallCompleted,
        toolCallsFailed: sessionLog.activity.toolCallFailed,
        errors: sessionLog.activity.errors,
        parsedLines: rollout.totals.parsed + sessionLog.files.reduce((acc, f) => acc + f.parsed, 0),
        malformedLines: rollout.totals.malformed + sessionLog.files.reduce((acc, f) => acc + f.malformed, 0),
      },
      logPaths: {
        runDir,
        report: null,
        out: logs.find((l) => l.label === 'out.log')?.path ?? null,
        err: logs.find((l) => l.label === 'err.log')?.path ?? null,
        rolloutDir: rollout.available ? rollout.dir : null,
        sessionLog: sessionLogPath,
      },
      diagnostics: boundStringList(diag, 10),
    });
  }
}
