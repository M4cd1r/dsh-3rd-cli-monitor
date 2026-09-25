// test/scheduler.test.mjs — polling and heartbeat cadences (required
// coverage area 6): deterministic ManualScheduler driving, plus real-timer
// behavior of IntervalScheduler.

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { AdapterRegistry } from '../src/adapters/registry.mjs';
import { MonitorService } from '../src/application/monitor-service.mjs';
import { FileRunStore } from '../src/storage/file-run-store.mjs';
import { IntervalScheduler, ManualScheduler, systemClock } from '../src/scheduling/interval-scheduler.mjs';
import { createRunSnapshot } from '../src/domain/model.mjs';
import { fakeClock, makeTempRoot } from './helpers/fixtures.mjs';

class FakeCliAdapter {
  id = 'fake';
  discoverRuns() {
    return this._runs ?? [];
  }
  observe(snapshot) {
    this._runs = [snapshot];
  }
}

function setup(t) {
  const clock = fakeClock();
  const adapter = new FakeCliAdapter();
  const store = new FileRunStore({ stateRoot: join(makeTempRoot(t), 'state'), clock });
  const scheduler = new ManualScheduler();
  const service = new MonitorService({ registry: new AdapterRegistry().register(adapter), getActiveCli: () => 'fake', store, scheduler, clock });
  return { adapter, store, scheduler, service, clock };
}

test('startCadences wires poll and heartbeat on the injected scheduler', async (t) => {
  const { adapter, store, scheduler, service, clock } = setup(t);
  adapter.observe(createRunSnapshot({ runId: 'r1', cliId: 'fake', state: 'running' }));

  const stop = service.startCadences({ pollMs: 1000, heartbeatMs: 60_000 });
  try {
    await scheduler.fire(1000); // one poll tick
    assert.equal(store.loadStatus('fake', 'r1').state, 'running');
    assert.equal(store.readEvents('fake', 'r1', { type: 'run.discovered' }).length, 1);

    await scheduler.fire(1000); // poll again: no new events (no change)
    assert.equal(store.readEvents('fake', 'r1').length, 1);

    await scheduler.fire(60_000); // heartbeat tick: appends run.heartbeat
    assert.equal(store.readEvents('fake', 'r1', { type: 'run.heartbeat' }).length, 1);
  } finally {
    stop();
  }
});

test('a poll tick that finds a transition beats before the next heartbeat', async (t) => {
  const { adapter, store, scheduler, service } = setup(t);
  adapter.observe(createRunSnapshot({ runId: 'r1', cliId: 'fake', state: 'running' }));
  const stop = service.startCadences({ pollMs: 1000, heartbeatMs: 60_000 });
  try {
    await scheduler.fire(1000);
    adapter.observe(createRunSnapshot({ runId: 'r1', cliId: 'fake', state: 'finished' }));
    await scheduler.fire(60_000); // heartbeat sees the transition
    const types = store.readEvents('fake', 'r1').map((e) => e.type);
    assert.deepEqual(types, ['run.discovered', 'run.state-changed']);
  } finally {
    stop();
  }
});

test('IntervalScheduler fires on real timers and honors stop()', { timeout: 5000 }, async () => {
  const scheduler = new IntervalScheduler();
  let ticks = 0;
  const stop = scheduler.every(5, () => {
    ticks += 1;
  });
  await delay(60);
  assert.ok(ticks >= 2, `expected at least 2 ticks, got ${ticks}`);
  stop();
  const atStop = ticks;
  await delay(30);
  assert.equal(ticks, atStop, 'no ticks after stop()');
  scheduler.stopAll();
});

test('IntervalScheduler rejects non-positive intervals and stopAll silences everything', async () => {
  const scheduler = new IntervalScheduler();
  assert.throws(() => scheduler.every(0, () => {}), /positive integer/);
  assert.throws(() => scheduler.every(-5, () => {}), /positive integer/);
  let ticks = 0;
  scheduler.every(5, () => {
    ticks += 1;
  });
  scheduler.stopAll();
  await delay(30);
  assert.equal(ticks, 0);
});

test('async tick bodies are awaited before the next tick (no overlap)', { timeout: 5000 }, async () => {
  const scheduler = new IntervalScheduler();
  let running = 0;
  let maxConcurrent = 0;
  let ticks = 0;
  const stop = scheduler.every(5, async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    ticks += 1;
    await delay(12);
    running -= 1;
  });
  await delay(50);
  stop();
  assert.equal(maxConcurrent, 1, 'tick bodies must never overlap');
  assert.ok(ticks >= 2);
});
