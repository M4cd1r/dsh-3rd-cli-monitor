// src/storage/run-lock.mjs — advisory per-run lock.
//
// A monitor acquires the lock inside a run's directory before reading or
// writing that run's state, so two monitor processes (e.g. the DSH host
// plugin and a standalone CLI watch) never duplicate work or interleave
// status.json writes for the same run. The lock is a lockfile created with
// O_EXCL ('wx'); it stores the owner and an expiry so a crashed monitor's
// stale lock is taken over instead of blocking forever.

import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_STALE_MS = 30_000;

export class FileRunLock {
  /**
   * @param {string} runDir - directory that will hold the lock file.
   * @param {{clock?: {now: () => number}, staleMs?: number, fileName?: string}} [opts]
   */
  constructor(runDir, opts = {}) {
    this.runDir = runDir;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
    this.fileName = opts.fileName ?? '.monitor-lock';
    this.path = join(runDir, this.fileName);
    this.token = randomUUID();
  }

  _read() {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8'));
    } catch {
      return null;
    }
  }

  _tryCreate(info) {
    let fd;
    try {
      fd = openSync(this.path, 'wx');
    } catch (err) {
      return err && err.code === 'EEXIST' ? false : null; // null: unexpected error
    }
    try {
      writeSync(fd, JSON.stringify(info));
    } finally {
      closeSync(fd);
    }
    return true;
  }

  /**
   * Acquire the lock.
   * @returns {{release(): void, token: string, stolen?: boolean}|null}
   *   A handle, or null when another live monitor holds the lock.
   */
  acquire() {
    const now = this.clock.now();
    const info = { token: this.token, pid: process.pid, acquiredAt: now, expiresAt: now + this.staleMs };
    const first = this._tryCreate(info);
    if (first === true) return this._handle(false);
    if (first === null) return null;
    // Lock file exists: take it over only when clearly stale.
    const holder = this._read();
    if (holder && Number.isFinite(holder.expiresAt) && holder.expiresAt > now) return null;
    try { unlinkSync(this.path); } catch { return null; }
    const retry = this._tryCreate(info);
    return retry === true ? this._handle(true) : null;
  }

  _handle(stolen) {
    const token = this.token;
    return {
      token,
      stolen,
      release: () => {
        const current = this._read();
        if (current && current.token === token) {
          try { unlinkSync(this.path); } catch { /* already gone */ }
        }
      },
    };
  }

  /** True when a lock file exists right now (regardless of staleness). */
  isHeld() {
    try {
      statSync(this.path);
      return true;
    } catch {
      return false;
    }
  }
}
