// test/host.test.mjs — DSH host lifecycle and remote contract with fakes
// (required coverage area 10).

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { apply, name, inject } from '../src/host/plugin.mjs';
import { mountTypertRemote, TYPERT_MANIFEST } from '../src/host/typert-remote.mjs';
import { fakeClock, makeTempRoot } from './helpers/fixtures.mjs';

function fakeCtx() {
  const services = new Map();
  const routes = new Map();
  const effects = [];
  const logs = [];
  const ctx = {
    provide: (n, svc) => services.set(n, svc),
    route: (method, path, handler) => routes.set(`${method} ${path}`, handler),
    effect: (fn, label) => effects.push({ cleanup: fn(), label }),
    log: {
      info: (...a) => logs.push(['info', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      error: (...a) => logs.push(['error', ...a]),
    },
  };
  return { ctx, services, routes, effects, logs };
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(payload) {
      this.body = payload;
    },
  };
  return res;
}

// Request stub: records 'data'/'end' handlers like a node IncomingMessage.
function realReq(url, body) {
  const handlers = {};
  return {
    url,
    on(event, fn) {
      handlers[event] = fn;
    },
    deliver() {
      if (body !== undefined) handlers.data?.(body);
      handlers.end?.();
    },
  };
}

test('plugin metadata follows the cordis entry contract', () => {
  assert.equal(name, 'dsh-3rd-cli-monitor');
  assert.deepEqual(inject, []);
});

test('apply mounts provide, routes, and cadence effects; remote reads work', async (t) => {
  const root = makeTempRoot(t);
  const { ctx, services, routes, effects } = fakeCtx();
  const started = apply(ctx, {
    stateRoot: join(root, 'state'),
    pollMs: 1000,
    heartbeatMs: 60_000,
    zcode: { logsDirs: [join(root, 'logs')], rolloutDir: join(root, 'rollout'), sessionLogDir: join(root, 'zlog') },
  });
  assert.ok(started, 'apply returns a handle');
  assert.equal(services.has('thirdCliMonitor'), true, 'remote is provided');

  const routeNames = [...routes.keys()].sort();
  assert.deepEqual(routeNames, [
    'GET /dsh-3rd-cli-monitor/events',
    'GET /dsh-3rd-cli-monitor/runs',
    'GET /dsh-3rd-cli-monitor/status',
    'POST /dsh-3rd-cli-monitor/active-cli',
  ]);
  assert.ok(effects.some((e) => e.label === 'dsh-3rd-cli-monitor: cadences'), 'cadences are effect-owned');

  await started.initial; // first poll settles without throwing
  const remote = services.get('thirdCliMonitor');
  const status = await remote.getStatus();
  assert.equal(status.cliId, 'zcode');
  assert.deepEqual(status.totals, {});
  assert.deepEqual(await remote.listRuns(), []);
  assert.equal(remote.describe().readOnly, true);

  // GET /status over the fake HTTP surface.
  const res = fakeRes();
  routes.get('GET /dsh-3rd-cli-monitor/status')(realReq('/dsh-3rd-cli-monitor/status'), res);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.status.cliId, 'zcode');
});

test('setActiveCli on the remote validates and switches observation only', async (t) => {
  const root = makeTempRoot(t);
  const { ctx, services } = fakeCtx();
  const started = apply(ctx, { stateRoot: join(root, 'state') });
  await started.initial;
  const remote = services.get('thirdCliMonitor');
  await assert.rejects(() => remote.setActiveCli('not-a-cli'), /unknown CLI/);
  assert.equal(await remote.setActiveCli('zcode'), 'zcode');
  assert.equal(remote.activeCli(), 'zcode');
});

test('POST active-cli route rejects unknown ids with a 400', async (t) => {
  const root = makeTempRoot(t);
  const { ctx, routes } = fakeCtx();
  const started = apply(ctx, { stateRoot: join(root, 'state') });
  await started.initial;
  const res = fakeRes();
  const req = realReq('/dsh-3rd-cli-monitor/active-cli', JSON.stringify({ cliId: 'ghost' }));
  routes.get('POST /dsh-3rd-cli-monitor/active-cli')(req, res);
  req.deliver();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /unknown CLI/);
});

test('apply degrades gracefully on a bare context without any optional surface', async (t) => {
  const root = makeTempRoot(t);
  const ctx = {}; // no provide, no route, no effect, no typert, no log
  const started = apply(ctx, { stateRoot: join(root, 'state') });
  assert.ok(started);
  await started.initial;
  assert.equal(ctx.thirdCliMonitor.describe().id, 'third-cli-monitor');
});

test('apply never throws even when the host surface misbehaves', async (t) => {
  const root = makeTempRoot(t);
  const ctx = {
    provide() {
      throw new Error('host exploded');
    },
    route() {
      throw new Error('route table broken');
    },
    effect() {
      throw new Error('effect scope gone');
    },
  };
  const started = apply(ctx, { stateRoot: join(root, 'state') });
  assert.ok(started, 'apply still returns; failures are contained');
  await started.initial;
});

test('effect cleanup stops the cadences without error', async (t) => {
  const root = makeTempRoot(t);
  const { ctx, effects } = fakeCtx();
  const started = apply(ctx, { stateRoot: join(root, 'state'), pollMs: 50, heartbeatMs: 50 });
  await started.initial;
  const cadenceEffect = effects.find((e) => e.label === 'dsh-3rd-cli-monitor: cadences');
  assert.ok(cadenceEffect);
  assert.doesNotThrow(() => cadenceEffect.cleanup());
});

test('mountTypertRemote registers the manifest when the peer and registry exist', async () => {
  const registered = [];
  const disposals = [];
  const effects = [];
  const ctx = {
    typert: {
      register: (manifest) => {
        registered.push(manifest);
        disposals.push(0);
        return () => {
          disposals[0] += 1;
        };
      },
    },
    effect: (fn, label) => effects.push({ cleanup: fn(), label }),
  };

  class FakeTypertRemoteService {
    constructor(hostContext, key) {
      this.hostContext = hostContext;
      this.key = key;
    }
  }
  const result = await mountTypertRemote(
    ctx,
    {
      remote: {
        getStatus: async () => ({}),
        listRuns: async () => [],
        getEvents: async () => [],
        setActiveCli: async (id) => id,
      },
      logger: { info() {}, warn() {} },
    },
    { importer: async () => ({ TypertRemoteService: FakeTypertRemoteService }) },
  );
  assert.equal(result.mounted, true);
  assert.equal(registered.length, 1);
  assert.equal(TYPERT_MANIFEST.model.services[0].key, 'thirdCliMonitor');
  assert.equal(registered[0], TYPERT_MANIFEST);

  // The manifest disposer is wired through the plugin's effect scope.
  const effect = effects.find((e) => e.label === 'dsh-3rd-cli-monitor: typert manifest');
  assert.ok(effect, 'typert disposal is effect-owned');
  effect.cleanup();
  assert.equal(disposals[0], 1);
});

test('mountTypertRemote reports gracefully without the registry or the peer', async () => {
  const noRegistry = await mountTypertRemote({}, { remote: {}, logger: {} });
  assert.equal(noRegistry.mounted, false);

  const { ctx } = fakeCtx();
  ctx.typert = { register: () => () => {} };
  const noPeer = await mountTypertRemote(ctx, { remote: {}, logger: {} }, {
    importer: async () => {
      const err = new Error('Cannot find package');
      err.code = 'ERR_MODULE_NOT_FOUND';
      throw err;
    },
  });
  assert.equal(noPeer.mounted, false);
  assert.match(noPeer.reason, /not resolvable/);
});
