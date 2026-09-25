// src/adapters/zcode/report-parser.mjs — whitelist extraction from report.json.
//
// The wrapper's report deliberately contains sensitive payload: the full
// prompt (fallbackContext.brief) and the model's final response text. This
// parser copies a fixed whitelist of metadata fields ONLY — presence of the
// response is recorded as a boolean, never its text — and bounds every
// free-form string. A whole-object spread here would be a privacy regression,
// so the field list is explicit and complete.

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { LIMITS, boundString } from '../../domain/redact.mjs';

const MAX_REPORT_BYTES = 4 * 1024 * 1024;

/**
 * Parse one wrapper report.json into bounded metadata.
 * @returns {{ok: true, meta: object}|{ok: false, reason: string}}
 */
export class ZcodeReportParser {
  /** @param {{maxBytes?: number}} [opts] */
  constructor(opts = {}) {
    this.maxBytes = opts.maxBytes ?? MAX_REPORT_BYTES;
  }

  parse(reportPath) {
    let stat;
    try {
      stat = statSync(reportPath);
    } catch {
      return { ok: false, reason: 'report.json not readable' };
    }
    if (stat.size > this.maxBytes) {
      return { ok: false, reason: `report.json too large to parse (${stat.size} bytes)` };
    }
    let raw;
    try {
      raw = readFileSync(reportPath, 'utf8');
    } catch (err) {
      return { ok: false, reason: `report.json read failed (${err.code ?? 'error'})` };
    }
    let report;
    try {
      report = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'report.json is not valid JSON (possibly torn write)' };
    }
    if (!report || typeof report !== 'object') {
      return { ok: false, reason: 'report.json is not an object' };
    }

    const responsePresent = typeof report.response === 'string' && report.response.trim() !== '';
    const fallback = report.fallbackContext ?? {};
    const logRefs = fallback.logRefs ?? {};
    const diag = this._sessionDiagnostics(report.sessionDiagnostics);

    const meta = {
      status: typeof report.status === 'string' ? report.status : 'unknown',
      errorKind: typeof report.errorKind === 'string' ? report.errorKind : null,
      model: typeof report.model === 'string' ? report.model : null,
      modelActual: typeof report.modelActual === 'string' ? report.modelActual : null,
      modelReasoningLevel: typeof report.modelReasoningLevel === 'string' ? report.modelReasoningLevel : null,
      modelVerification: typeof report.modelVerification === 'string' ? report.modelVerification : null,
      modelsUsed: (Array.isArray(report.modelsUsed) ? report.modelsUsed : [])
        .filter((m) => typeof m === 'string' && m)
        .slice(0, LIMITS.modelsUsed),
      durationMs: Number.isFinite(report.durationMs) ? Math.max(0, Math.floor(report.durationMs)) : null,
      changedFilesCount: Array.isArray(report.changedFiles) ? report.changedFiles.length : null,
      planFile: typeof report.plan === 'string' ? boundString(basename(report.plan), 120) : null,
      responsePresent,
      partialState: boundString(fallback.partialState, LIMITS.partialStateChars),
      logRefs: {
        out: typeof logRefs.out === 'string' ? logRefs.out : null,
        err: typeof logRefs.err === 'string' ? logRefs.err : null,
        rollout: typeof logRefs.rollout === 'string' ? logRefs.rollout : null,
        sessionLog: typeof logRefs.sessionLog === 'string' ? logRefs.sessionLog : null,
      },
      diag,
    };
    return { ok: true, meta };
  }

  /**
   * Fold the wrapper's own metadata-only session diagnostics into plain
   * counters. Only numbers and directory paths are taken; never nested
   * content.
   */
  _sessionDiagnostics(sd) {
    if (!sd || typeof sd !== 'object') return null;
    const rollout = sd.rollout ?? {};
    const files = Array.isArray(rollout.files) ? rollout.files : [];
    let requests = 0;
    let responses = 0;
    let emptyResponses = 0;
    let malformed = 0;
    for (const f of files) {
      requests += Number(f?.requests) || 0;
      responses += Number(f?.responses) || 0;
      emptyResponses += Number(f?.emptyResponses) || 0;
      malformed += Number(f?.malformed) || 0;
    }
    const activity = sd.sessionLog?.activity ?? {};
    const num = (v) => (Number.isFinite(v) ? v : 0);
    return {
      rolloutDir: typeof rollout.dir === 'string' ? rollout.dir : null,
      rolloutFiles: files.length,
      requests,
      responses,
      emptyResponses,
      malformed,
      sessionLogDir: typeof sd.sessionLog?.dir === 'string' ? sd.sessionLog.dir : null,
      modelRequestsCompleted: num(activity.modelRequestCompleted),
      toolCallsCompleted: num(activity.toolCallCompleted),
      toolCallsFailed: num(activity.toolCallFailed),
      errors: num(activity.errors),
    };
  }
}
