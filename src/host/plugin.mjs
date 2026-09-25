// src/host/plugin.mjs — the DSH host half.
//
// Cordis entry contract: exports `name`, `inject`, and `apply(ctx, config)`.
// The apply body is defensive by design: this plugin is purely additive
// observability, so NO failure inside it may take the host down. A missing
// logs directory, an absent Typert registry, or an unresolvable peer package
// all degrade to "no remote surface / no runs yet" — never to a boot error.
//
// The plugin registers no tools and no commands, owns no durable state beyond
// its own state root, and performs no writes outside `$DSH_HOME/
// third-cli-monitor`. It never starts, cancels, or restarts a third-party CLI.

import { resolveMonitorConfig } from '../config.mjs';
import { assemble } from '../compose.mjs';
import { LIMITS } from '../domain/redact.mjs';
import { mountTypertRemote, TYPERT_MANIFEST } from './typert-remote.mjs';

/** Cordis plugin name. */
export const name = 'dsh-3rd-cli-monitor';

/**
 * Lenient on purpose: everything optional (Typert, routes) is
 * feature-detected inside apply, so the plugin loads on hosts that lack any
 * of those surfaces instead of failing an inject dependency.
 */
export const inject = [];

const PLUGIN_VERSION = '0.1.0';

/** Build the read-only remote object shared by provide / routes / Typert. */
function createRemote(components) {
  const { service, activeCli, registry } = components;
  return {
    version: PLUGIN_VERSION,
    describe() {
      return {
        id: 'third-cli-monitor',
        version: PLUGIN_VERSION,
        readOnly: true,
        cliIds: registry.ids(),
        activeCli: activeCli.get(),
      };
    },
    getStatus(filter = {}) {
      return service.getStatus(filter);
    },
    listRuns(filter = {}) {
      return service.listRuns({
        ...filter,
        limit: Math.min(filter.limit ?? LIMITS.listRunsDefault, LIMITS.listRunsMax),
      });
    },
    getEvents(filter = {}) {
      return service.getEvents(filter);
    },
    setActiveCli(cliId) {
      // async on purpose: a synchronous RangeError must reach callers as a
      // rejected promise, not as an exception from the remote surface.
      return (async () => activeCli.set(cliId))();
    },
    activeCli() {
      return activeCli.get();
    },
  };
}

function makeLogger(ctx) {
  const probe = ctx?.log ?? ctx?.logger ?? console;
  const pick = (level, fallback) => {
    const fn = typeof probe?.[level] === 'function' ? probe[level].bind(probe) : fallback;
    return (...args) => {
      try {
        (fn ?? (() => {}))(...args);
      } catch {
        // logging must never break the host
      }
    };
  };
  return {
    info: pick('info', console.info),
    warn: pick('warn', console.warn),
    error: pick('error', console.error),
  };
}

function mountRoutes(ctx, remote, logger) {
  const sendJson = (res, code, body) => {
    try {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    } catch {
      // ignore
    }
  };
  ctx.route('GET', '/dsh-3rd-cli-monitor/status', (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      remote.getStatus({ cliId: url.searchParams.get('cliId') ?? undefined })
        .then((status) => sendJson(res, 200, { ok: true, status }))
        .catch((err) => sendJson(res, 500, { ok: false, error: String(err?.message ?? err) }));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  });
  ctx.route('GET', '/dsh-3rd-cli-monitor/runs', (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      const limit = Number(url.searchParams.get('limit') ?? undefined);
      remote.listRuns({
        cliId: url.searchParams.get('cliId') ?? undefined,
        state: url.searchParams.get('state') ?? undefined,
        limit: Number.isInteger(limit) ? limit : undefined,
      })
        .then((runs) => sendJson(res, 200, { ok: true, runs }))
        .catch((err) => sendJson(res, 500, { ok: false, error: String(err?.message ?? err) }));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  });
  ctx.route('GET', '/dsh-3rd-cli-monitor/events', (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      remote.getEvents({
        cliId: url.searchParams.get('cliId') ?? undefined,
        runId: url.searchParams.get('runId') ?? undefined,
        type: url.searchParams.get('type') ?? undefined,
      })
        .then((events) => sendJson(res, 200, { ok: true, events }))
        .catch((err) => sendJson(res, 500, { ok: false, error: String(err?.message ?? err) }));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  });
  // The one write on this surface — and it only retargets observation, never
  // any CLI process.
  ctx.route('POST', '/dsh-3rd-cli-monitor/active-cli', (req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw = (raw + chunk).slice(0, 2000);
    });
    req.on('error', () => sendJson(res, 400, { ok: false, error: 'request error' }));
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        // Remote methods are asynchronous; await them inside the route so a
        // rejected validation becomes a 400 response instead of an unhandled
        // rejection and a misleading 200 response.
        const cliId = await remote.setActiveCli(body.cliId);
        sendJson(res, 200, { ok: true, activeCli: cliId });
      } catch (err) {
        const message = String(err?.message ?? err);
        sendJson(res, message.startsWith('activeCli:') ? 400 : 500, { ok: false, error: message });
      }
    });
  });
}

function startPlugin(ctx, config) {
  const logger = makeLogger(ctx);
  const cfg = resolveMonitorConfig({ overrides: config, env: process.env });
  const components = assemble(cfg, { logger });
  const remote = createRemote(components);

  try {
    if (typeof ctx?.provide === 'function') ctx.provide('thirdCliMonitor', remote);
    else if (ctx && typeof ctx === 'object') ctx.thirdCliMonitor = remote;
  } catch (err) {
    logger.warn(`[dsh-3rd-cli-monitor] provide failed: ${err?.message ?? err}`);
  }

  try {
    if (typeof ctx?.route === 'function') mountRoutes(ctx, remote, logger);
  } catch (err) {
    logger.warn(`[dsh-3rd-cli-monitor] routes unavailable: ${err?.message ?? err}`);
  }

  // Fire-and-forget: the remote surface is optional; results are logged.
  mountTypertRemote(ctx, { remote, logger })
    .then((result) => {
      if (!result.mounted) logger.info(`[dsh-3rd-cli-monitor] typert remote not mounted: ${result.reason}`);
    })
    .catch((err) => logger.warn(`[dsh-3rd-cli-monitor] typert mount error: ${err?.message ?? err}`));

  // One immediate pass so status exists before the first tick; then the two
  // cadences, owned by the plugin's effect scope.
  const initial = components.service.pollOnce()
    .then((result) => {
      if (result.unavailable) logger.info(`[dsh-3rd-cli-monitor] first poll: ${result.error ?? 'unavailable'}`);
      else logger.info(`[dsh-3rd-cli-monitor] first poll: ${result.discovered} run(s) for ${result.cliId}`);
    })
    .catch((err) => logger.warn(`[dsh-3rd-cli-monitor] first poll failed: ${err?.message ?? err}`));

  const stop = components.service.startCadences({ pollMs: cfg.pollMs, heartbeatMs: cfg.heartbeatMs });
  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        stop();
      }, 'dsh-3rd-cli-monitor: cadences');
    }
  } catch (err) {
    logger.warn(`[dsh-3rd-cli-monitor] effect registration failed: ${err?.message ?? err}`);
  }
  return { initial, components, remote, config: cfg };
}

/**
 * @param {object} ctx - host cordis context.
 * @param {object} [config] - the patch row's `config` object (see
 *   cordus.patch.yml and docs/operations.md).
 */
export function apply(ctx, config = {}) {
  try {
    return startPlugin(ctx, config ?? {});
  } catch (err) {
    // Absolutely nothing here may propagate into host boot.
    try {
      const log = ctx?.log ?? ctx?.logger ?? console;
      if (typeof log?.error === 'function') log.error('[dsh-3rd-cli-monitor] apply failed', err);
    } catch {
      // ignore
    }
    return null;
  }
}

export { TYPERT_MANIFEST };
