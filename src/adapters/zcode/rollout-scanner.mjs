// src/adapters/zcode/rollout-scanner.mjs — bounded metadata scan of the
// ZCode CLI's rollout log (~/.zcode/cli/rollout/model-io-*.jsonl).
//
// One JSON object is appended per model request with its startedAt,
// sessionId, request.body.model, and response summary. This scanner answers,
// for a run's time window: how many model requests were made, how many got a
// non-empty response, which models actually served them, and which session
// ids were involved (session ids also ride the file names). It is
// metadata-only: counters, timestamps, ids, and model names — log lines are
// parsed but never copied out. Malformed lines, including a final line torn
// by a concurrent writer, are counted and skipped.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '../../domain/redact.mjs';

const SLACK_MS = 5_000;

export class ZcodeRolloutScanner {
  /**
   * @param {{rolloutDir: string, bounds?: {filesPerScan?: number, maxFileBytes?: number, sessionsPerScan?: number, modelsPerScan?: number}}} opts
   */
  constructor(opts) {
    this.rolloutDir = opts.rolloutDir;
    this.bounds = {
      filesPerScan: opts.bounds?.filesPerScan ?? LIMITS.filesPerScan,
      maxFileBytes: opts.bounds?.maxFileBytes ?? 16 * 1024 * 1024,
      sessionsPerScan: opts.bounds?.sessionsPerScan ?? LIMITS.sessionsPerScan,
      modelsPerScan: opts.bounds?.modelsPerScan ?? LIMITS.modelsUsed,
    };
  }

  /**
   * Scan rollout files whose mtime falls within the window.
   * @param {{sinceMs?: number}} [opts]
   * @returns {{available: boolean, dir: string, files: object[], totals: object, sessionIds: string[], models: string[], truncated: boolean}}
   */
  scan({ sinceMs } = {}) {
    const out = {
      available: false,
      dir: this.rolloutDir,
      files: [],
      totals: { requests: 0, responses: 0, emptyResponses: 0, malformed: 0, parsed: 0 },
      sessionIds: [],
      models: [],
      truncated: false,
    };
    let names;
    try {
      names = readdirSync(this.rolloutDir);
    } catch {
      return out; // no rollout dir yet: unavailable, never fatal
    }
    out.available = true;
    const fromMs = (sinceMs ?? 0) - SLACK_MS;
    const sessions = new Set();
    const models = new Set();
    for (const name of names.filter((n) => n.startsWith('model-io-') && n.endsWith('.jsonl')).sort()) {
      if (out.files.length >= this.bounds.filesPerScan) {
        out.truncated = true;
        break;
      }
      const full = join(this.rolloutDir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < fromMs) continue;
      const file = this._scanFile(full, name, stat, fromMs, sessions, models);
      out.files.push(file);
      out.totals.requests += file.requests;
      out.totals.responses += file.responses;
      out.totals.emptyResponses += file.emptyResponses;
      out.totals.malformed += file.malformed;
      out.totals.parsed += file.parsed;
    }
    out.sessionIds = [...sessions].slice(0, this.bounds.sessionsPerScan);
    out.models = [...models].slice(0, this.bounds.modelsPerScan);
    return out;
  }

  _scanFile(full, name, stat, fromMs, sessions, models) {
    const file = {
      name,
      bytes: stat.size,
      requests: 0, responses: 0, emptyResponses: 0,
      parsed: 0, malformed: 0,
      models: [],
      firstStartedAt: null, lastStartedAt: null,
    };
    if (stat.size > this.bounds.maxFileBytes) {
      file.skipped = 'file too large to parse';
      return file;
    }
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch (err) {
      file.readError = err?.code ?? 'read-failed';
      return file;
    }
    const fileModels = new Set();
    const nameSession = (/^model-io-(.+)\.jsonl$/.exec(name) ?? [])[1];
    if (nameSession && sessions.size < this.bounds.sessionsPerScan) sessions.add(nameSession);
    let firstMs = null;
    let lastMs = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        file.malformed += 1; // includes a torn final line from a live writer
        continue;
      }
      file.parsed += 1;
      const at = Date.parse(entry?.startedAt ?? '');
      if (Number.isFinite(at)) {
        if (firstMs === null || at < firstMs) firstMs = at;
        if (lastMs === null || at > lastMs) lastMs = at;
        if (at < fromMs) continue; // before this run's window
      }
      const sid = (typeof entry?.sessionId === 'string' && entry.sessionId) || nameSession;
      if (sid && sessions.size < this.bounds.sessionsPerScan) sessions.add(sid);
      const model = entry?.request?.body?.model;
      if (typeof model === 'string' && model.trim()) {
        file.requests += 1;
        fileModels.add(model);
        models.add(model);
      }
      const resp = entry?.response;
      if (resp) file.responses += 1;
      const hasText = typeof resp?.text === 'string' && resp.text.trim() !== '';
      const hasToolCalls = Array.isArray(resp?.toolCalls) && resp.toolCalls.length > 0;
      if (!resp || (!hasText && !hasToolCalls)) file.emptyResponses += 1;
    }
    file.models = [...fileModels].slice(0, this.bounds.modelsPerScan);
    if (firstMs !== null) {
      file.firstStartedAt = new Date(firstMs).toISOString();
      file.lastStartedAt = new Date(lastMs).toISOString();
    }
    return file;
  }
}
