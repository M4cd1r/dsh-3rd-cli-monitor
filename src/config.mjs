// src/config.mjs — one config resolver for every entry point.
//
// The DSH host plugin (patch-row config object), the standalone CLI (flags),
// and tests all call resolveMonitorConfig. Priority: explicit overrides >
// environment > defaults. The state root defaults to $DSH_HOME/
// third-cli-monitor so the host plugin and the CLI see the same data.

import { homedir as defaultHomedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULTS = Object.freeze({
  activeCli: 'zcode',
  pollMs: 15_000,
  heartbeatMs: 60_000,
  lockStaleMs: 30_000,
});

function positiveInt(value, fallback, { min = 250 } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) return fallback;
  return n;
}

/**
 * @param {{env?: object, overrides?: object, homedir?: string}} [opts]
 *   `overrides` comes from the caller's own surface (patch-row config object
 *   or parsed CLI flags); `env` is process.env in production, a fake in tests.
 */
export function resolveMonitorConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const home = opts.homedir ?? defaultHomedir();
  const o = opts.overrides ?? {};

  let stateRoot = o.stateRoot;
  if (!stateRoot && env.DSH_3RD_CLI_MONITOR_STATE_ROOT) stateRoot = env.DSH_3RD_CLI_MONITOR_STATE_ROOT;
  if (!stateRoot) {
    const dshHome = (env.DSH_HOME ?? '').trim();
    stateRoot = dshHome ? join(dshHome, 'third-cli-monitor') : join(home, '.dsh', 'third-cli-monitor');
  }

  return {
    stateRoot,
    activeCli: typeof o.activeCli === 'string' && o.activeCli ? o.activeCli : DEFAULTS.activeCli,
    pollMs: positiveInt(o.pollMs, DEFAULTS.pollMs),
    heartbeatMs: positiveInt(o.heartbeatMs, DEFAULTS.heartbeatMs),
    lockStaleMs: positiveInt(o.lockStaleMs, DEFAULTS.lockStaleMs),
    zcode: {
      logsDirs: o.zcode?.logsDirs ?? o.logsDirs,
      rolloutDir: o.zcode?.rolloutDir,
      sessionLogDir: o.zcode?.sessionLogDir,
      runningFreshMs: o.zcode?.runningFreshMs,
      orphanAfterMs: o.zcode?.orphanAfterMs,
    },
  };
}
