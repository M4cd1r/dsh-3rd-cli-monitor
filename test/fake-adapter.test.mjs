// test/fake-adapter.test.mjs — a new adapter can be added without any change
// to application or host code (required coverage area 5).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AdapterRegistry } from '../src/adapters/registry.mjs';
import { ZcodeCliAdapter } from '../src/adapters/zcode/adapter.mjs';
import { ActiveCliService } from '../src/application/active-cli.mjs';
import { MonitorService } from '../src/application/monitor-service.mjs';
import { FileRunStore } from '../src/storage/file-run-store.mjs';
import { createRunSnapshot } from '../src/domain/model.mjs';
import { fakeClock, makeTempRoot, writeRunDir } from './helpers/fixtures.mjs';

/** Written HERE, in test code only: an adapter for an imaginary CLI. */
class CursorLikeAdapter {
  id = 'cursorlike';
  displayName = 'CursorLike (imaginary)';
  #runs = new Map();

  observe(runId, state, extra = {}) {
    this.#runs.set(runId, createRunSnapshot({ runId, cliId: this.id, state, ...extra }));
  }

  discoverRuns() {
    return [...this.#runs.values()];
  }
}

function buildSystem(t) {
  const root = makeTempRoot(t);
  const clock = fakeClock();
  const registry = new AdapterRegistry();
  const zcode = new ZcodeCliAdapter({
    clock,
    logsDirs: [join(root, 'logs')],
    rolloutDir: join(root, 'rollout'),
    sessionLogDir: join(root, 'zlog'),
  });
  registry.register(zcode);
  const cursorlike = new CursorLikeAdapter();
  registry.register(cursorlike);
  const store = new FileRunStore({ stateRoot: join(root, 'state'), clock });
  const activeCli = new ActiveCliService({ stateRoot: join(root, 'state'), registry, clock });
  const service = new MonitorService({
    registry,
    getActiveCli: () => activeCli.get(),
    store,
    clock,
  });
  return { root, registry, store, activeCli, service, cursorlike };
}

test('a test-defined adapter plugs in and is served by the unchanged application', async (t) => {
  const { store, activeCli, service, cursorlike } = buildSystem(t);

  // Default stays zcode; switch observation to the foreign adapter.
  assert.equal(activeCli.get(), 'zcode');
  activeCli.set('cursorlike');
  assert.equal(activeCli.get(), 'cursorlike');

  cursorlike.observe('cur-1', 'running', { model: 'imaginary-model' });
  const poll = await service.pollOnce();
  assert.equal(poll.cliId, 'cursorlike');
  assert.equal(poll.discovered, 1);

  const persisted = store.loadStatus('cursorlike', 'cur-1');
  assert.equal(persisted.state, 'running');
  assert.equal(persisted.cliId, 'cursorlike');
});

test('switching back to zcode observes zcode artifacts, same application path', async (t) => {
  const { root, store, activeCli, service, cursorlike } = buildSystem(t);
  const startedMs = fakeClock().nowMs - 60_000;
  writeRunDir(join(root, 'logs'), { startedMs, slug: 'native', outText: 'work\n', mtimeMs: fakeClock().nowMs - 1000 });

  activeCli.set('cursorlike');
  cursorlike.observe('cur-1', 'finished');
  await service.pollOnce();

  activeCli.set('zcode');
  const poll = await service.pollOnce();
  assert.equal(poll.cliId, 'zcode');
  assert.equal(poll.discovered, 1);
  assert.equal(store.loadStatus('zcode', `${new Date(startedMs).toISOString().replace(/[:.]/g, '-')}-native`).slug, 'native');

  // Both CLI namespaces coexist under the one state root.
  assert.deepEqual(readdirSync(join(root, 'state', 'runs')).sort(), ['cursorlike', 'zcode']);
});

test('registries reject duplicate ids and malformed adapters', () => {
  const registry = new AdapterRegistry();
  const adapter = new CursorLikeAdapter();
  registry.register(adapter);
  assert.throws(() => registry.register(new CursorLikeAdapter()), /already registered/);
  assert.throws(() => registry.register({ id: 'x' }), /discoverRuns/);
  assert.throws(() => registry.register({ discoverRuns() {} }), /adapter\.id/);
});
