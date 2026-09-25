// test/event-contract.test.mjs — the provider-neutral event contract
// (required coverage area 4), driven through a fake adapter.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { AdapterRegistry } from '../src/adapters/registry.mjs';
import { MonitorService } from '../src/application/monitor-service.mjs';
import { FileRunStore } from '../src/storage/file-run-store.mjs';
import { ManualScheduler } from '../src/scheduling/interval-scheduler.mjs';
import { createRunSnapshot, EVENT_TYPES, EVENT_SCHEMA } from '../src/domain/model.mjs';
import { fakeClock, makeTempRoot } from './helpers/fixtures.mjs';

/** A provider-neutral fake: proves the application never touches ZCode. */
class FakeCliAdapter {
  id = 'fake';
  displayName = 'Fake CLI';
  constructor() {
    this.observations = [];
  }
  discoverRuns() {
    return this.observations;
  }
  seed(...snapshots) {
    this.observations = snapshots;
  }
}

function setup(t) {
  const root = makeTempRoot(t);
  const clock = fakeClock();
  const adapter = new FakeCliAdapter();
  const registry = new AdapterRegistry().register(adapter);
  const store = new FileRunStore({ stateRoot: join(root, 'state'), clock });
  const scheduler = new ManualScheduler();
  const service = new MonitorService({
    registry,
    getActiveCli: () => 'fake',
    store,
    scheduler,
    clock,
  });
  return { adapter, registry, store, scheduler, service, clock };
}

test('first observation emits run.discovered with a closed event shape', async (t) => {
  const { adapter, store, service, clock } = setup(t);
  adapter.seed(createRunSnapshot({ runId: 'r1', cliId: 'fake', state: 'running' }));
  await service.pollOnce();

  const events = store.readEvents('fake', 'r1');
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.schema, EVENT_SCHEMA);
  assert.equal(event.type, 'run.discovered');
  assert.equal(event.fromState, null);
  assert.equal(event.toState, 'running');
  assert.equal(event.cliId, 'fake');
  assert.equal(event.runId, 'r1');
  assert.ok(typeof event.id === 'string' && event.id);
  assert.ok(!Number.isNaN(Date.parse(event.at)));
});

test('transitions emit run.state-changed with fromState/toState; stable polls emit nothing', async (t) => {
  const { adapter, store, service, clock } = setup(t);
  adapter.seed(createRunSnapshot({ runId: 'r1', cliId: 'fake', state: 'running', counts: { modelRequests: 1 } }));
  await service.pollOnce();
  adapter.seed(createRunSnapshot({ runId: 'r1', cliId: 'fake', state: 'finished', counts: { modelRequests: 1 } }));
  await service.pollOnce();
  // An identical re-observation (same fingerprint) must not re-emit.
  await service.pollOnce();

  const events = store.readEvents('fake', 'r1');
  assert.equal(events.length, 2);
  const [discovered, changed] = events;
  assert.equal(discovered.type, 'run.discovered');
  assert.equal(changed.type, 'run.state-changed');
  assert.equal(changed.fromState, 'running');
  assert.equal(changed.toState, 'finished');
  assert.ok(EVENT_TYPES.includes(changed.type));
});

test('heartbeat ticks refresh open runs and emit run.heartbeat; terminal runs stay quiet', async (t) => {
  const { adapter, store, service } = setup(t);
  adapter.seed(
    createRunSnapshot({ runId: 'open', cliId: 'fake', state: 'running' }),
    createRunSnapshot({ runId: 'done', cliId: 'fake', state: 'finished' }),
  );
  await service.pollOnce();

  const beforeDone = store.loadStatus('fake', 'done');
  await service.heartbeatOnce();

  const openEvents = store.readEvents('fake', 'open', { type: 'run.heartbeat' });
  assert.equal(openEvents.length, 1);
  assert.equal(openEvents[0].fromState, 'running');
  assert.equal(openEvents[0].toState, 'running');
  // Terminal run untouched by the heartbeat.
  assert.equal(store.loadStatus('fake', 'done').observedAt, beforeDone.observedAt);
  assert.equal(store.readEvents('fake', 'done', { type: 'run.heartbeat' }).length, 0);
});

test('events carry only the contract fields (no provider-specific payload)', async (t) => {
  const { adapter, store, service } = setup(t);
  adapter.seed(createRunSnapshot({
    runId: 'r1',
    cliId: 'fake',
    state: 'running',
    diagnostics: ['some internal detail'],
  }));
  await service.pollOnce();
  const [event] = store.readEvents('fake', 'r1');
  assert.deepEqual(Object.keys(event).sort(), [
    'at', 'cliId', 'fromState', 'id', 'reason', 'runId', 'schema', 'sessionId', 'toState', 'type',
  ]);
});
