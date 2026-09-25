// src/host/typert-remote.mjs — the optional Typert/Remote surface.
//
// When the host exposes the Typert registry (DSH 0.1.7+), this module mounts
// the read-only `thirdCliMonitor` Remote service so a future client panel can
// poll getStatus/listRuns/getEvents and switch the observed CLI. The mount is
// strictly additive and guarded: if the peer packages or the registry are
// unavailable, the plugin still works through ctx.provide / ctx.route and the
// standalone CLI — this is why nothing here is imported statically.

/**
 * The strict manifest registered through `ctx.typert.register`. Registering
 * it — rather than relying on decorator markers, which a plain-JS plugin
 * cannot produce — is the same path the dsh-offpeak host uses, and is what
 * makes the Host Gateway resolve `thirdCliMonitor/<method>` endpoints.
 */
export const TYPERT_MANIFEST = Object.freeze({
  package: '@m4cd1r/dsh-3rd-cli-monitor',
  face: 'host',
  schemas: [],
  model: {
    services: [
      {
        key: 'thirdCliMonitor',
        exportName: 'ThirdCliMonitorRuntime',
        description: 'Read-only monitoring of third-party coding CLI runs (log/report artifacts only).',
        tags: [],
        members: [
          { kind: 'method', name: 'getStatus', signature: 'getStatus(filter?): Promise<object>' },
          { kind: 'method', name: 'listRuns', signature: 'listRuns(filter?): Promise<object[]>' },
          { kind: 'method', name: 'getEvents', signature: 'getEvents(filter & { runId: string }): Promise<object[]>' },
          { kind: 'method', name: 'setActiveCli', signature: 'setActiveCli(cliId: string): Promise<string>' },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: [],
});

const PROTOCOL_PACKAGE = '@deepseek-ai/dsh-typert-protocol';

async function defaultImporter(id) {
  return import(id);
}

/**
 * Mount the Remote service when the host supports it.
 *
 * @param {object} ctx - host cordis context.
 * @param {{remote: object, logger?: object}} deps - the shared remote object.
 * @param {{importer?: (id: string) => Promise<object>}} [opts] - injectable
 *   module importer (tests pass a fake; production uses dynamic import).
 * @returns {Promise<{mounted: boolean, reason?: string}>}
 */
export async function mountTypertRemote(ctx, deps, opts = {}) {
  const { remote, logger } = deps;
  const log = (level, ...args) => {
    try {
      logger?.[level]?.(...args);
    } catch {
      // ignore
    }
  };
  const registry = ctx?.typert;
  if (!registry || typeof registry.register !== 'function') {
    return { mounted: false, reason: 'ctx.typert.register is not available on this host' };
  }
  let protocol;
  try {
    protocol = await (opts.importer ?? defaultImporter)(PROTOCOL_PACKAGE);
  } catch (err) {
    const reason = `peer package ${PROTOCOL_PACKAGE} not resolvable (${err?.code ?? err?.message ?? 'error'})`;
    log('info', `[dsh-3rd-cli-monitor] remote surface disabled: ${reason}`);
    return { mounted: false, reason };
  }
  const Base = protocol?.TypertRemoteService;
  if (typeof Base !== 'function') {
    const reason = `${PROTOCOL_PACKAGE} has no TypertRemoteService export`;
    log('info', `[dsh-3rd-cli-monitor] remote surface disabled: ${reason}`);
    return { mounted: false, reason };
  }

  // No decorator markers in plain JS — the strict manifest above is what the
  // gateway resolves; this subclass only binds the wire namespace and
  // delegates to the shared remote object.
  class ThirdCliMonitorRuntime extends Base {
    constructor() {
      super(ctx, 'thirdCliMonitor');
    }

    getStatus(filter) {
      return remote.getStatus(filter);
    }

    listRuns(filter) {
      return remote.listRuns(filter);
    }

    getEvents(filter) {
      return remote.getEvents(filter ?? {});
    }

    setActiveCli(cliId) {
      return remote.setActiveCli(cliId);
    }
  }

  try {
    new ThirdCliMonitorRuntime();
  } catch (err) {
    return { mounted: false, reason: `service binding failed: ${err?.message ?? err}` };
  }
  try {
    const dispose = registry.register(TYPERT_MANIFEST);
    // When the host disposes the plugin, unregister the endpoints via the
    // closure (the registration itself happened asynchronously).
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        try {
          dispose?.();
        } catch {
          // ignore
        }
      }, 'dsh-3rd-cli-monitor: typert manifest');
    }
    log('info', '[dsh-3rd-cli-monitor] typert remote mounted (thirdCliMonitor)');
    return { mounted: true };
  } catch (err) {
    return { mounted: false, reason: `manifest registration failed: ${err?.message ?? err}` };
  }
}
