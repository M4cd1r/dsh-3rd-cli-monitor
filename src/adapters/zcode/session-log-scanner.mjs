// src/adapters/zcode/session-log-scanner.mjs — bounded metadata scan of the
// ZCode CLI's session log (~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl).
//
// One JSON object is appended per session event with a timestamp, sessionId,
// event/type name, and level. This scanner counts events for a run's time
// window (optionally narrowed to that run's session ids): model request
// starts/completions, tool call starts/completions/failures, turns, and
// errors, plus the most frequent event names — counts only, never message or
// context fields. Malformed lines, including a torn final line, are counted
// and skipped.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '../../domain/redact.mjs';

const SLACK_MS = 5_000;

const SESSION_ACTIVITY_EVENTS = {
  'model.request.started': 'modelRequestStarted',
  'model.request.completed': 'modelRequestCompleted',
  'model.response.diagnostics': 'modelResponseDiagnostics',
  'tool.call.started': 'toolCallStarted',
  'tool.call.completed': 'toolCallCompleted',
  'tool.call.failed': 'toolCallFailed',
  'turn.completed': 'turnsCompleted',
};

export class ZcodeSessionLogScanner {
  /**
   * @param {{sessionLogDir: string, bounds?: {filesPerScan?: number, maxFileBytes?: number, eventNames?: number}}} opts
   */
  constructor(opts) {
    this.sessionLogDir = opts.sessionLogDir;
    this.bounds = {
      filesPerScan: opts.bounds?.filesPerScan ?? 3,
      maxFileBytes: opts.bounds?.maxFileBytes ?? 16 * 1024 * 1024,
      eventNames: opts.bounds?.eventNames ?? LIMITS.diagnosticsPerSnapshot,
    };
  }

  /**
   * Scan the daily session logs covering the window for event counters.
   * @param {{sinceMs?: number, sessionIds?: string[]}} [opts]
   * @returns {{available: boolean, dir: string, files: object[], activity: object, eventNamesSeen: number, eventNames: string[], truncated: boolean}}
   */
  scan({ sinceMs, sessionIds = [] } = {}) {
    const out = {
      available: false,
      dir: this.sessionLogDir,
      files: [],
      activity: {
        modelRequestStarted: 0, modelRequestCompleted: 0, modelResponseDiagnostics: 0,
        toolCallStarted: 0, toolCallCompleted: 0, toolCallFailed: 0,
        turnsCompleted: 0, errors: 0,
      },
      eventNamesSeen: 0,
      eventNames: [],
      truncated: false,
    };
    let names;
    try {
      names = readdirSync(this.sessionLogDir);
    } catch {
      return out; // no session log dir yet: unavailable, never fatal
    }
    out.available = true;
    const fromMs = (sinceMs ?? 0) - SLACK_MS;
    const filter = new Set(sessionIds);
    const eventCounts = new Map();
    for (const name of this._candidateFiles(names, sinceMs)) {
      if (out.files.length >= this.bounds.filesPerScan) {
        out.truncated = true;
        break;
      }
      const full = join(this.sessionLogDir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      const file = { name, bytes: stat.size, parsed: 0, malformed: 0, firstTimestamp: null, lastTimestamp: null };
      out.files.push(file);
      if (stat.size > this.bounds.maxFileBytes) {
        file.skipped = 'file too large to parse';
        continue;
      }
      this._scanFile(full, file, fromMs, filter, out.activity, eventCounts);
    }
    out.eventNamesSeen = eventCounts.size;
    out.eventNames = [...eventCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, this.bounds.eventNames)
      .map(([name, count]) => `${name}=${count}`);
    return out;
  }

  // The CLI stamps one file per UTC day; a window near midnight spans two.
  _candidateFiles(names, sinceMs) {
    const pattern = /^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/;
    if (!Number.isFinite(sinceMs)) {
      return names.filter((n) => pattern.test(n)).sort().reverse().slice(0, this.bounds.filesPerScan);
    }
    const wanted = new Set();
    for (const t of [sinceMs - 86_400_000, sinceMs, Date.now()]) {
      wanted.add(new Date(t).toISOString().slice(0, 10));
    }
    return names
      .filter((n) => pattern.test(n) && wanted.has(n.slice(6, -6)))
      .sort()
      .reverse()
      .slice(0, this.bounds.filesPerScan);
  }

  _scanFile(full, file, fromMs, sessionFilter, activity, eventCounts) {
    let text;
    try {
      text = readFileSync(full, 'utf8');
    } catch (err) {
      file.readError = err?.code ?? 'read-failed';
      return;
    }
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
      const ts = Date.parse(entry?.timestamp ?? '');
      if (Number.isFinite(ts)) {
        if (firstMs === null || ts < firstMs) firstMs = ts;
        if (lastMs === null || ts > lastMs) lastMs = ts;
        if (ts < fromMs) continue; // logged before the run window
      }
      if (sessionFilter.size) {
        const sid = entry?.sessionId;
        if (!sid || !sessionFilter.has(sid)) continue; // a sibling session's events
      }
      const eventName = (typeof entry?.event === 'string' && entry.event)
        || (typeof entry?.type === 'string' && entry.type)
        || '<unknown>';
      eventCounts.set(eventName, (eventCounts.get(eventName) ?? 0) + 1);
      const key = SESSION_ACTIVITY_EVENTS[eventName];
      if (key) activity[key] += 1;
      if (entry?.level === 'error' || eventName.endsWith('.failed')) activity.errors += 1;
    }
    if (firstMs !== null) {
      file.firstTimestamp = new Date(firstMs).toISOString();
      file.lastTimestamp = new Date(lastMs).toISOString();
    }
  }
}
