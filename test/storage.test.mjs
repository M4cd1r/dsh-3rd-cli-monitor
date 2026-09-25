// test/storage.test.mjs — atomic status writes, append-only bounded events,
// and duplicate-run locking (required coverage area 7).

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FileRunStore } from '../src/storage/file-run-store.mjs';
import { createRunSnapshot, createRunEvent } from '../src/domain/model.mjs';
import { fakeClock, makeTempRoot } from './helpers/fixtures.mjs';

function setup(t, { eventFileMaxBytes } = {}) {
  const root = makeTempRoot(t);
  const clock = fakeClock();
  const store = new FileRunStore({ stateRoot: join(root, 'state'), clock, eventFileMaxBytes });
  return { root, clock, store };
}

const snapshotFor = (runId, state = 'running') =>
  createRunSnapshot({ runId, cliId: 'zcode', state, startedAt: '2026-09-24T09:00:00Z' });

test('status.json is replaced atomically with no temp litter', (t) => {
  const { root, store } = setup(t);
  const runDir = join(root, 'state', 'runs', 'zcode', 'r1');
  store.writeStatus(snapshotFor('r1', 'running'));
  assert.equal(store.loadStatus('zcode', 'r1').state, 'running');
  store.writeStatus(snapshotFor('r1', 'finished'));
  assert.equal(store.loadStatus('zcode', 'r1').state, 'finished');
  const leftovers = readdirSync(runDir).filter((n) => n.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('events are appended (append-only), oldest first, and read bounded', (t) => {
  const { store } = setup(t);
  const event = (n) => createRunEvent({
    type: 'run.state-changed',
    runId: 'r1',
    cliId: 'zcode',
    fromState: 'running',
    toState: 'finished',
    at: new Date(1_700_000_000_000 + n).toISOString(),
  }, { idGen: () => `id-${n}` });
  store.appendEvents('zcode', 'r1', [event(1)]);
  store.appendEvents('zcode', 'r1', [event(2), event(3)]);
  const events = store.readEvents('zcode', 'r1');
  assert.deepEqual(events.map((e) => e.id), ['id-1', 'id-2', 'id-3']);
  assert.equal(store.readEvents('zcode', 'r1', { limit: 2 }).length, 2);
  assert.equal(store.readEvents('zcode', 'r1', { type: 'run.discovered' }).length, 0);
});

test('event files rotate with one kept generation once the size cap is exceeded', (t) => {
  const { root, store } = setup(t, { eventFileMaxBytes: 200 });
  const heartbeat = (n) => createRunEvent({
    type: 'run.heartbeat',
    runId: 'r1',
    cliId: 'zcode',
    fromState: 'running',
    toState: 'running',
  }, { idGen: () => `hb-${n}` });
  for (let i = 0; i < 6; i++) store.appendEvents('zcode', 'r1', [heartbeat(i)]);
  const runDir = join(root, 'state', 'runs', 'zcode', 'r1');
  assert.equal(existsSync(join(runDir, 'events.1.jsonl')), true, 'previous generation kept');
  const all = store.readEvents('zcode', 'r1', { limit: 500 });
  // Rotation intentionally retains only the previous generation. These events
  // are larger than the cap, so the readable window is exactly the last two.
  assert.deepEqual(all.map((event) => event.id), ['hb-4', 'hb-5']);
  assert.equal(all.length, 2, 'readEvents must remain bounded to two generations');
});

test('a torn trailing event line is skipped on read, never fatal', (t) => {
  const { root, store } = setup(t);
  store.appendEvents('zcode', 'r1', [createRunEvent({
    type: 'run.discovered', runId: 'r1', cliId: 'zcode', toState: 'running',
  }, { idGen: () => 'ok-1' })]);
  const runDir = join(root, 'state', 'runs', 'zcode', 'r1');
  appendFileSync(join(runDir, 'events.jsonl'), '{"schema":"dsh-3rd-cli-monitor/e'); // torn tail
  const events = store.readEvents('zcode', 'r1');
  assert.deepEqual(events.map((e) => e.id), ['ok-1']);
});

test('loadStatus returns null for missing or corrupt status files', (t) => {
  const { root, store } = setup(t);
  assert.equal(store.loadStatus('zcode', 'nope'), null);
  const runDir = join(root, 'state', 'runs', 'zcode', 'bad');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'status.json'), '{corrupt');
  assert.equal(store.loadStatus('zcode', 'bad'), null);
});

test('listRuns filters by cli, state, and limit; newest first', (t) => {
  const { store } = setup(t);
  store.writeStatus(createRunSnapshot({ runId: 'a', cliId: 'zcode', state: 'finished', startedAt: '2026-09-24T09:00:00Z' }));
  store.writeStatus(createRunSnapshot({ runId: 'b', cliId: 'zcode', state: 'running', startedAt: '2026-09-24T10:00:00Z' }));
  store.writeStatus(createRunSnapshot({ runId: 'c', cliId: 'fake', state: 'running', startedAt: '2026-09-24T11:00:00Z' }));
  assert.deepEqual(store.listRuns().map((r) => r.runId), ['c', 'b', 'a']);
  assert.deepEqual(store.listRuns({ cliId: 'zcode' }).map((r) => r.runId), ['b', 'a']);
  assert.deepEqual(store.listRuns({ state: 'running' }).map((r) => r.runId), ['c', 'b']);
  assert.equal(store.listRuns({ limit: 1 }).length, 1);
});

test('per-run lock excludes a second monitor until release', (t) => {
  const { store } = setup(t);
  const lock = store.acquireRunLock('zcode', 'r1');
  assert.ok(lock, 'first acquire must win');
  assert.equal(store.acquireRunLock('zcode', 'r1'), null, 'second acquire must be excluded');
  lock.release();
  const again = store.acquireRunLock('zcode', 'r1');
  assert.ok(again, 'acquire after release must win');
  again.release();
});

test('a stale lock (older than staleMs) is taken over, not honored', (t) => {
  const { clock, store } = setup(t);
  const lock = store.acquireRunLock('zcode', 'r1', { staleMs: 1000 });
  assert.ok(lock);
  clock.advance(2000); // the original lock expired meanwhile
  const stolen = store.acquireRunLock('zcode', 'r1', { staleMs: 30_000 });
  assert.ok(stolen, 'a stale lock must be takeable');
  assert.equal(stolen.stolen, true);
  stolen.release();
  const fresh = store.acquireRunLock('zcode', 'r1');
  assert.ok(fresh);
  assert.equal(fresh.stolen ?? false, false);
  fresh.release();
});

test('unsafe path segments are rejected', (t) => {
  const { store } = setup(t);
  assert.throws(() => store.writeStatus(createRunSnapshot({ runId: '..', cliId: 'zcode' })), /unsafe/);
});
