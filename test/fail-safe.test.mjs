// test/fail-safe.test.mjs — missing/unavailable logs fail safely and the
// poll loop never propagates adapter failures (required coverage area 9).

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { AdapterRegistry } from '../src/adapters/registry.mjs';
import { ZcodeCliAdapter } from '../src/adapters/zcode/adapter.mjs';
import { MonitorService } from '../src/application/monitor-service.mjs';
import { FileRunStore } from '../src/storage/file-run-store.mjs';
import { createRunSnapshot } from '../src/domain/model.mjs';
import { fakeClock, makeTempRoot, writeRunDir } from './helpers/fixtures.mjs';

const T0 = fakeClock().nowMs;

test('a missing logs directory discovers nothing and never throws', (t) => {
  const root = makeTempRoot(t);
  const clock = fakeClock(T0);
  const adapter = new ZcodeCliAdapter({
    clock,
    logsDirs: [join(root, 'missing', 'logs')],
    rolloutDir: join(root, 'rollout'),
    sessionLogDir: join(root, 'zlog'),
  });
  assert.deepEqual(adapter.discoverRuns(), []);
});

test('pollOnce reports unavailability instead of throwing when an adapter explodes', async (t) => {
  const root = makeTempRoot(t);
  const clock = fakeClock(T0);
  const exploding = {
    id: 'exploding',
    displayName: 'Exploding',
    discoverRuns() {
      throw new Error('simulated adapter crash');
    },
  };
  const store = new FileRunStore({ stateRoot: join(root, 'state'), clock });
  const service = new MonitorService({
    registry: new AdapterRegistry().register(exploding),
    getActiveCli: () => 'exploding',
    store,
    clock,
  });
  const result = await service.pollOnce();
  assert.equal(result.unavailable, true);
  assert.match(result.error, /simulated adapter crash/);
});

test('pollOnce with no adapter for the active CLI is a handled condition', async (t) => {
  const root = makeTempRoot(t);
  const service = new MonitorService({
    registry: new AdapterRegistry(),
    getActiveCli: () => 'nothing-registered',
    store: new FileRunStore({ stateRoot: join(root, 'state'), clock: fakeClock(T0) }),
    clock: fakeClock(T0),
  });
  const result = await service.pollOnce();
  assert.equal(result.unavailable, true);
  assert.match(result.error, /no adapter/);
});

test('a fresh state root is created on demand; first poll persists cleanly', async (t) => {
  const root = makeTempRoot(t);
  const clock = fakeClock(T0);
  const logsDir = join(root, 'logs');
  const startedMs = T0 - 120_000;
  writeRunDir(logsDir, { startedMs, slug: 'first', outText: 'work\n', mtimeMs: T0 - 1000 });
  const adapter = new ZcodeCliAdapter({
    clock,
    logsDirs: [logsDir],
    rolloutDir: join(root, 'rollout'),
    sessionLogDir: join(root, 'zlog'),
  });
  const store = new FileRunStore({ stateRoot: join(root, 'never', 'existed', 'state'), clock });
  const service = new MonitorService({
    registry: new AdapterRegistry().register(adapter),
    getActiveCli: () => 'zcode',
    store,
    clock,
  });
  const result = await service.pollOnce();
  assert.equal(result.discovered, 1);
  assert.equal(store.loadStatus('zcode', adapter.discoverRuns()[0].runId).slug, 'first');
});

test('empty run directories and unreadable reports degrade to discovered/unknown', (t) => {
  const root = makeTempRoot(t);
  const logsDir = join(root, 'logs');
  writeRunDir(logsDir, { startedMs: T0 - 30_000, slug: 'bare' }); // nothing in it
  writeRunDir(logsDir, { startedMs: T0 - 60_000, slug: 'torn', report: 'garbage' });
  const runs = new ZcodeCliAdapter({
    clock: fakeClock(T0),
    logsDirs: [logsDir],
    rolloutDir: join(root, 'rollout'),
    sessionLogDir: join(root, 'zlog'),
  }).discoverRuns();
  const bySlug = Object.fromEntries(runs.map((r) => [r.slug, r.state]));
  assert.equal(bySlug.bare, 'discovered');
  assert.equal(bySlug.torn, 'unknown');
});

test('a monitor holding the run lock makes pollOnce skip that run silently', async (t) => {
  const root = makeTempRoot(t);
  const clock = fakeClock(T0);
  const store = new FileRunStore({ stateRoot: join(root, 'state'), clock });
  const snapshot = createRunSnapshot({ runId: 'locked', cliId: 'zcode', state: 'running' });
  const foreign = store.acquireRunLock('zcode', 'locked');
  assert.ok(foreign);
  const service = new MonitorService({
    registry: new AdapterRegistry().register({
      id: 'zcode',
      displayName: 'ZCode',
      discoverRuns: () => [snapshot],
    }),
    getActiveCli: () => 'zcode',
    store,
    clock,
  });
  const result = await service.pollOnce();
  assert.equal(result.discovered, 1);
  assert.equal(result.changed, 0, 'the locked run must not be processed');
  assert.equal(store.loadStatus('zcode', 'locked'), null, 'nothing persisted for the locked run');
  foreign.release();
});
