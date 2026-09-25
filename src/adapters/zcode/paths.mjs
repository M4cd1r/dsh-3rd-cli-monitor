// src/adapters/zcode/paths.mjs — discovery of ZCode artifact locations.
//
// The wrapper (zcode-run.mjs in the zcode skill) writes one directory per run
// under its logs dir, named `<UTC ISO stamp with - for : and .>-<slug>` and
// containing report.json / out.log / err.log. The ZCode CLI itself writes
// model I/O under ~/.zcode/cli/rollout and session events under
// ~/.zcode/cli/log. All locations are configurable with the same environment
// variables the wrapper honors, so the monitor observes exactly the
// directories the wrapper actually uses.

import { homedir as defaultHomedir } from 'node:os';
import { join } from 'node:path';

/** `<stamp>-<slug>` run directory names, e.g. 2026-09-24T09-32-34-486Z-brief. */
export const RUN_DIR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(.+)$/;

/** Parse a wrapper run directory name into { stamp, slug, startedMs }. */
export function parseRunDirName(name) {
  const match = RUN_DIR_PATTERN.exec(name);
  if (!match) return null;
  const [, stamp, slug] = match;
  const datePart = `${stamp.slice(0, 10)}T${stamp.slice(11)}`;
  const ms = Date.parse(datePart.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1T$2:$3:$4.$5Z'));
  return Number.isFinite(ms) ? { stamp, slug, startedMs: ms } : null;
}

function splitPathsEnv(value) {
  return String(value)
    .split(process.platform === 'win32' ? /[;,]/ : /[:;,]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Resolve the directories to scan for wrapper run directories.
 * Priority: explicit config > DSH_3RD_CLI_MONITOR_ZCODE_LOGS > the wrapper's
 * own ZCODE_SKILL_LOGS > the zcode skill's default logs dir.
 * @param {{env?: object, homedir?: string, logsDirs?: string|string[]}} [opts]
 * @returns {string[]}
 */
export function resolveLogsDirs(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? defaultHomedir();
  const fromConfig = opts.logsDirs == null
    ? []
    : (Array.isArray(opts.logsDirs) ? opts.logsDirs : [opts.logsDirs]);
  if (fromConfig.length > 0) return fromConfig;
  if (env.DSH_3RD_CLI_MONITOR_ZCODE_LOGS) return splitPathsEnv(env.DSH_3RD_CLI_MONITOR_ZCODE_LOGS);
  if (env.ZCODE_SKILL_LOGS) return splitPathsEnv(env.ZCODE_SKILL_LOGS);
  return [join(home, '.agents', 'skills', 'zcode', 'logs')];
}

/** The ZCode CLI data root: $ZCODE_DATA_BASE_DIR or ~/.zcode. */
export function resolveDataRoot(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? defaultHomedir();
  const base = (env.ZCODE_DATA_BASE_DIR ?? '').trim() || home;
  return join(base, '.zcode');
}

export function rolloutDirFor(dataRoot) {
  return join(dataRoot, 'cli', 'rollout');
}

export function sessionLogDirFor(dataRoot) {
  return join(dataRoot, 'cli', 'log');
}
