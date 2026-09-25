// src/storage/file-run-store.mjs — the durable state root.
//
// Layout under `<stateRoot>` (default `$DSH_HOME/third-cli-monitor`):
//
//   runs/<cliId>/<runId>/status.json    one normalized snapshot, atomic replace
//   runs/<cliId>/<runId>/events.jsonl   append-only bounded event log
//   runs/<cliId>/<runId>/events.1.jsonl previous generation after rotation
//   runs/<cliId>/<runId>/.monitor-lock  per-run advisory lock
//
// Everything is plain JSON/JSONL on disk so the CLI, the DSH host plugin, and
// a future client panel read the exact same bytes.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { LIMITS } from '../domain/redact.mjs';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { FileRunLock } from './run-lock.mjs';

const STATUS_FILE = 'status.json';
const EVENTS_FILE = 'events.jsonl';
const EVENTS_PREV = 'events.1.jsonl';

function safeSegment(segment) {
  const cleaned = String(segment).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 150);
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new RangeError(`unsafe path segment: ${segment}`);
  return cleaned;
}

/**
 * File-backed implementation of the RunStore, EventStore, and RunLockManager
 * ports. One class, three small faces — the application depends on each face
 * through its port, not on this concrete type.
 */
export class FileRunStore {
  /**
   * @param {{stateRoot: string, clock?: {now: () => number}, eventFileMaxBytes?: number}} opts
   */
  constructor(opts) {
    if (!opts || !opts.stateRoot) throw new TypeError('FileRunStore: stateRoot is required');
    this.stateRoot = opts.stateRoot;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.eventFileMaxBytes = opts.eventFileMaxBytes ?? LIMITS.eventFileMaxBytes;
  }

  runDir(cliId, runId) {
    return join(this.stateRoot, 'runs', safeSegment(cliId), safeSegment(runId));
  }

  _ensureRunDir(cliId, runId) {
    const dir = this.runDir(cliId, runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ---------------------------------------------------------------- status --

  /** Atomically replace the run's status.json with this snapshot. */
  writeStatus(snapshot) {
    const dir = this._ensureRunDir(snapshot.cliId, snapshot.runId);
    atomicWriteFileSync(join(dir, STATUS_FILE), JSON.stringify(snapshot, null, 2));
  }

  /** Last persisted snapshot, or null when absent or unreadable. */
  loadStatus(cliId, runId) {
    try {
      const raw = readFileSync(join(this.runDir(cliId, runId), STATUS_FILE), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * List persisted snapshots, newest first.
   * @param {{cliId?: string, state?: string, limit?: number}} [filter]
   */
  listRuns(filter = {}) {
    const limit = Math.min(Math.max(1, filter.limit ?? LIMITS.listRunsDefault), LIMITS.listRunsMax);
    const runsRoot = join(this.stateRoot, 'runs');
    let topLevel;
    try {
      topLevel = readdirSync(runsRoot, { withFileTypes: true });
    } catch {
      return []; // no runs written yet: an empty store, not an error
    }
    const cliIds = filter.cliId
      ? [filter.cliId]
      : topLevel.filter((e) => e.isDirectory()).map((e) => e.name);
    const found = [];
    for (const cliId of cliIds) {
      const cliRoot = join(runsRoot, cliId);
      let entries;
      try {
        entries = readdirSync(cliRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const snapshot = this.loadStatus(cliId, entry.name);
        if (!snapshot) continue;
        if (filter.state && snapshot.state !== filter.state) continue;
        found.push(snapshot);
      }
    }
    found.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')));
    return found.slice(0, limit);
  }

  // ---------------------------------------------------------------- events --

  /**
   * Append events as JSONL, rotating to `events.1.jsonl` (one generation
   * kept) when the live file grows past the size cap. Appends never rewrite
   * the live file.
   */
  appendEvents(cliId, runId, events) {
    if (!Array.isArray(events) || events.length === 0) return;
    const dir = this._ensureRunDir(cliId, runId);
    const live = join(dir, EVENTS_FILE);
    let size = 0;
    try {
      size = statSync(live).size;
    } catch {
      size = 0;
    }
    if (size >= this.eventFileMaxBytes) this._rotate(dir);
    const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    appendFileSync(live, lines);
  }

  _rotate(dir) {
    const live = join(dir, EVENTS_FILE);
    const prev = join(dir, EVENTS_PREV);
    try {
      if (existsSync(prev)) unlinkSync(prev);
      renameSync(live, prev);
    } catch {
      // Rotation is best effort; the append below still proceeds.
    }
  }

  /**
   * Read events oldest-generation-first, newest last.
   * @param {{limit?: number, type?: string, since?: string}} [filter]
   */
  readEvents(cliId, runId, filter = {}) {
    const limit = Math.min(Math.max(1, filter.limit ?? LIMITS.eventsDefault), LIMITS.eventsMax);
    const dir = this.runDir(cliId, runId);
    const events = [];
    for (const name of [EVENTS_PREV, EVENTS_FILE]) {
      let raw;
      try {
        raw = readFileSync(join(dir, name), 'utf8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue; // torn tail after a crash is skipped, never fatal
        }
        if (filter.type && event?.type !== filter.type) continue;
        if (filter.since && typeof event?.at === 'string' && event.at < filter.since) continue;
        events.push(event);
      }
    }
    return events.slice(-limit);
  }

  // ------------------------------------------------------------------ lock --

  /**
   * Acquire the per-run lock; null when another live monitor holds it.
   * @param {{staleMs?: number}} [opts]
   */
  acquireRunLock(cliId, runId, opts = {}) {
    try {
      this._ensureRunDir(cliId, runId);
    } catch {
      return null;
    }
    return new FileRunLock(this.runDir(cliId, runId), {
      clock: this.clock,
      staleMs: opts.staleMs,
    }).acquire();
  }
}
