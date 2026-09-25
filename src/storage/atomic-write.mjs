// src/storage/atomic-write.mjs — crash-safe file replacement.
//
// Writes a temporary file in the destination directory, then renames it over
// the target. On POSIX rename is atomic; on Windows Node's rename uses
// MoveFileEx with REPLACE_EXISTING, which can transiently fail with EPERM
// when antivirus or a reader briefly holds the target — so a small bounded
// retry loop smooths that over.

import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Synchronous sleep without spawning anything or blocking the event loop
// unreasonably: Atomics.wait parks this thread for a few milliseconds.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Environments without Atomics.wait: fall through and retry immediately.
  }
}

/**
 * Atomically replace `filePath` with `data` (string or Buffer).
 * @param {string} filePath - destination file path.
 * @param {string|Buffer} data - full file content.
 * @param {{retries?: number, backoffMs?: number}} [opts]
 */
export function atomicWriteFileSync(filePath, data, { retries = 4, backoffMs = 25 } = {}) {
  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // let writeFileSync surface a real creation failure below
  }
  const tmp = join(dir, `.${randomUUID()}.tmp`);
  writeFileSync(tmp, data);
  let attempt = 0;
  for (;;) {
    try {
      renameSync(tmp, filePath);
      return;
    } catch (err) {
      const transient = err && (err.code === 'EPERM' || err.code === 'EACCES');
      attempt += 1;
      if (!transient || attempt > retries) {
        try { unlinkSync(tmp); } catch { /* best effort */ }
        throw err;
      }
      sleepSync(backoffMs * attempt);
    }
  }
}
