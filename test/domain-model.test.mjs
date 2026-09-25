// test/domain-model.test.mjs — the provider-neutral model and its bounds.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RUN_STATES,
  OPEN_STATES,
  TERMINAL_STATES,
  EVENT_TYPES,
  SNAPSHOT_SCHEMA,
  EVENT_SCHEMA,
  createRunSnapshot,
  createRunEvent,
  isValidState,
  isOpenState,
  isTerminalState,
  snapshotFingerprint,
} from '../src/domain/model.mjs';

test('run states are the closed contract set', () => {
  assert.deepEqual(RUN_STATES, [
    'discovered', 'running', 'waiting', 'response-ready',
    'finished', 'timed-out', 'failed', 'orphaned', 'unknown',
  ]);
  assert.deepEqual([...TERMINAL_STATES].sort(), ['failed', 'finished', 'orphaned', 'timed-out']);
  for (const state of OPEN_STATES) assert.ok(!isTerminalState(state));
  for (const state of TERMINAL_STATES) assert.ok(!isOpenState(state));
});

test('createRunSnapshot normalizes and bounds input', () => {
  const snapshot = createRunSnapshot({
    runId: 'run-1',
    cliId: 'zcode',
    state: 'running',
    startedAt: '2026-09-24T09:00:00.000Z',
    modelsUsed: Array.from({ length: 20 }, (_, i) => `model-${i}`),
    diagnostics: Array.from({ length: 30 }, (_, i) => `diagnostic line ${i} — ${'x'.repeat(300)}`),
    counts: { modelRequests: 5, nonsense: 99 },
    logPaths: { report: '/tmp/report.json', promptPath: '/tmp/prompt.txt' },
    partialState: 'y'.repeat(2000),
  });
  assert.equal(snapshot.schema, SNAPSHOT_SCHEMA);
  assert.equal(snapshot.modelsUsed.length, 8);
  assert.equal(snapshot.diagnostics.length, 10);
  assert.ok(snapshot.diagnostics.every((d) => d.length <= 200));
  assert.equal(snapshot.counts.modelRequests, 5);
  assert.equal(snapshot.counts.nonsense, undefined);
  assert.equal(snapshot.logPaths.report, '/tmp/report.json');
  assert.equal(snapshot.logPaths.promptPath, undefined);
  assert.ok(snapshot.partialState.length <= 500);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.counts), true);
});

test('createRunSnapshot defaults unknown state and requires ids', () => {
  assert.equal(createRunSnapshot({ runId: 'r', cliId: 'zcode', state: 'bogus' }).state, 'unknown');
  assert.throws(() => createRunSnapshot({ cliId: 'zcode' }), /runId/);
  assert.throws(() => createRunSnapshot({ runId: 'r' }), /cliId/);
});

test('createRunEvent validates type and states; idGen is injectable', () => {
  const event = createRunEvent({
    type: 'run.state-changed',
    runId: 'r',
    cliId: 'zcode',
    fromState: 'running',
    toState: 'finished',
  }, { idGen: () => 'fixed-id' });
  assert.equal(event.schema, EVENT_SCHEMA);
  assert.equal(event.id, 'fixed-id');
  assert.equal(event.fromState, 'running');
  assert.ok(event.at);
  assert.throws(() => createRunEvent({ type: 'nope', runId: 'r', cliId: 'zcode', toState: 'finished' }), /type/);
  assert.throws(() => createRunEvent({ type: 'run.discovered', runId: 'r', cliId: 'zcode', toState: 'nope' }), /state/);
  assert.throws(() => createRunEvent({ type: 'run.discovered', runId: 'r', cliId: 'zcode', fromState: 'nope', toState: 'finished' }), /fromState/);
  assert.ok(EVENT_TYPES.includes('run.heartbeat'));
});

test('snapshotFingerprint ignores observation time but sees state changes', () => {
  const base = { runId: 'r', cliId: 'zcode', state: 'running', observedAt: '2026-09-24T10:00:00Z' };
  const later = { ...base, observedAt: '2026-09-24T11:00:00Z' };
  const finished = { ...base, state: 'finished' };
  assert.equal(snapshotFingerprint(base), snapshotFingerprint(later));
  assert.notEqual(snapshotFingerprint(base), snapshotFingerprint(finished));
});

test('isValidState rejects garbage without throwing', () => {
  assert.equal(isValidState('running'), true);
  assert.equal(isValidState('RUNNING'), false);
  assert.equal(isValidState(undefined), false);
});
