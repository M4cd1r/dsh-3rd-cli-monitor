// src/compose.mjs — the composition root.
//
// The one module allowed to know every concrete class. Both entry points —
// the DSH host plugin and the standalone CLI — call `assemble()` so they run
// the exact same application/domain code over the exact same state root.

import { AdapterRegistry } from './adapters/registry.mjs';
import { ZcodeCliAdapter } from './adapters/zcode/adapter.mjs';
import { ActiveCliService } from './application/active-cli.mjs';
import { MonitorService } from './application/monitor-service.mjs';
import { nullLogger } from './domain/ports.mjs';
import { FileRunStore } from './storage/file-run-store.mjs';
import { IntervalScheduler, systemClock } from './scheduling/interval-scheduler.mjs';

/**
 * Build a wired monitor over `config` (see resolveMonitorConfig).
 * @param {object} config
 * @param {{scheduler?: object, logger?: object, clock?: object, adapters?: object[]}} [opts]
 *   Injected ports override the production defaults (tests use this).
 */
export function assemble(config, opts = {}) {
  const clock = opts.clock ?? systemClock;
  const logger = opts.logger ?? nullLogger;
  const registry = new AdapterRegistry();
  for (const adapter of opts.adapters ?? [new ZcodeCliAdapter({ clock, ...config.zcode })]) {
    registry.register(adapter);
  }
  const store = new FileRunStore({ stateRoot: config.stateRoot, clock });
  const activeCli = new ActiveCliService({
    stateRoot: config.stateRoot,
    registry,
    defaultCli: config.activeCli,
    clock,
    logger,
  });
  const service = new MonitorService(
    {
      registry,
      getActiveCli: () => activeCli.get(),
      store,
      scheduler: opts.scheduler ?? new IntervalScheduler({ unref: true }),
      clock,
      logger,
    },
    { lockStaleMs: config.lockStaleMs },
  );
  return { config, registry, store, activeCli, service, clock, logger };
}
