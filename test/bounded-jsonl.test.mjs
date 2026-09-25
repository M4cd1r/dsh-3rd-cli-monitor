// test/bounded-jsonl.test.mjs — bounded JSONL parsing with malformed and
// torn final lines (required coverage area 2).

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

import { ZcodeRolloutScanner } from '../src/adapters/zcode/rollout-scanner.mjs';
import { ZcodeSessionLogScanner } from '../src/adapters/zcode/session-log-scanner.mjs';
import { fakeClock, makeTempRoot, writeRolloutEntries, writeSessionEvents } from './helpers/fixtures.mjs';

const T0 = fakeClock().nowMs;
const WINDOW_START = T0 - 60_000;

test('rollout scanner tolerates malformed lines and a torn final line', (t) => {
  const root = makeTempRoot(t);
  const rolloutDir = join(root, 'rollout');
  writeRolloutEntries(rolloutDir, 'sess_ok', [
    { atMs: WINDOW_START + 1000, model: 'GLM-5.3-Flash' },
    { atMs: WINDOW_START + 2000, model: 'GLM-5.3-Flash', empty: true },
  ]);
  const file = join(rolloutDir, 'model-io-sess_ok.jsonl');
  appendFileSync(file, '{"startedAt": not-json\n'); // malformed line
  appendFileSync(file, '{"startedAt":"2026-09-24T0'); // torn final line, no newline

  const scan = new ZcodeRolloutScanner({ rolloutDir }).scan({ sinceMs: WINDOW_START });
  assert.equal(scan.available, true);
  assert.equal(scan.totals.parsed, 2);
  assert.equal(scan.totals.malformed, 2);
  assert.equal(scan.totals.requests, 2);
  assert.equal(scan.totals.emptyResponses, 1);
  assert.deepEqual(scan.sessionIds, ['sess_ok']);
});

test('rollout scanner skips files outside the time window and respects bounds', (t) => {
  const root = makeTempRoot(t);
  const rolloutDir = join(root, 'rollout');
  // Old file: mtime pushed back before the window start.
  writeRolloutEntries(rolloutDir, 'sess_old', [{ atMs: WINDOW_START - 10 * 60_000, model: 'old' }]);
  utimesSync(join(rolloutDir, 'model-io-sess_old.jsonl'), new Date(WINDOW_START - 10 * 60_000), new Date(WINDOW_START - 10 * 60_000));
  // Two fresh files, but the scanner is bound to one file per scan.
  writeRolloutEntries(rolloutDir, 'sess_a', [{ atMs: WINDOW_START + 1000, model: 'a' }]);
  writeRolloutEntries(rolloutDir, 'sess_b', [{ atMs: WINDOW_START + 2000, model: 'b' }]);

  const scanner = new ZcodeRolloutScanner({ rolloutDir, bounds: { filesPerScan: 1 } });
  const scan = scanner.scan({ sinceMs: WINDOW_START });
  assert.equal(scan.files.length, 1);
  assert.equal(scan.truncated, true);
  assert.ok(scan.sessionIds.includes('sess_a') || scan.sessionIds.includes('sess_b'));
  assert.ok(!scan.sessionIds.includes('sess_old'));
});

test('rollout scanner skips oversized files instead of parsing them', (t) => {
  const root = makeTempRoot(t);
  const rolloutDir = join(root, 'rollout');
  writeRolloutEntries(rolloutDir, 'sess_big', [{ atMs: WINDOW_START + 1000, model: 'big' }]);
  const scanner = new ZcodeRolloutScanner({ rolloutDir, bounds: { maxFileBytes: 10 } });
  const scan = scanner.scan({ sinceMs: WINDOW_START });
  assert.equal(scan.files.length, 1);
  assert.equal(scan.files[0].skipped, 'file too large to parse');
  assert.equal(scan.totals.requests, 0);
});

test('rollout scanner reports unavailability when the directory is missing', (t) => {
  const root = makeTempRoot(t);
  const scan = new ZcodeRolloutScanner({ rolloutDir: join(root, 'missing') }).scan({ sinceMs: WINDOW_START });
  assert.equal(scan.available, false);
  assert.deepEqual(scan.files, []);
});

test('session log scanner counts window events, errors, and top event names', (t) => {
  const root = makeTempRoot(t);
  const sessionLogDir = join(root, 'zlog');
  writeSessionEvents(sessionLogDir, WINDOW_START + 500, [
    { sessionId: 's1', event: 'model.request.started' },
    { sessionId: 's1', event: 'model.request.completed' },
    { sessionId: 's1', event: 'tool.call.completed' },
    { sessionId: 's1', event: 'tool.call.failed' },
    { sessionId: 'other', event: 'model.request.completed' }, // sibling session
  ]);
  // An event logged before the window must not be counted.
  writeSessionEvents(sessionLogDir, WINDOW_START - 10_000, [
    { sessionId: 's1', event: 'tool.call.completed' },
  ]);
  const scan = new ZcodeSessionLogScanner({ sessionLogDir })
    .scan({ sinceMs: WINDOW_START, sessionIds: ['s1'] });
  assert.equal(scan.available, true);
  assert.equal(scan.activity.modelRequestCompleted, 1);
  assert.equal(scan.activity.toolCallCompleted, 1);
  assert.equal(scan.activity.toolCallFailed, 1);
  assert.equal(scan.activity.errors, 1);
  assert.ok(scan.eventNames.some((entry) => entry.startsWith('model.request.started=')));
});

test('session log scanner counts a torn final line as malformed without failing', (t) => {
  const root = makeTempRoot(t);
  const sessionLogDir = join(root, 'zlog');
  writeSessionEvents(sessionLogDir, WINDOW_START + 500, [
    { sessionId: 's1', event: 'turn.completed' },
  ]);
  appendFileSync(join(sessionLogDir, `zcode-${new Date(WINDOW_START).toISOString().slice(0, 10)}.jsonl`),
    '{"timestamp":"2026-09-24T1'); // torn
  const scan = new ZcodeSessionLogScanner({ sessionLogDir })
    .scan({ sinceMs: WINDOW_START, sessionIds: ['s1'] });
  assert.equal(scan.files[0].malformed, 1);
  assert.equal(scan.activity.turnsCompleted, 1);
});

test('session log scanner bounds event names and tolerates missing directories', (t) => {
  const root = makeTempRoot(t);
  const sessionLogDir = join(root, 'zlog');
  writeSessionEvents(sessionLogDir, WINDOW_START + 500, Array.from({ length: 30 }, (_, i) => ({
    sessionId: 's1',
    event: `custom.event.${i}`,
  })));
  const scan = new ZcodeSessionLogScanner({ sessionLogDir, bounds: { eventNames: 5 } })
    .scan({ sinceMs: WINDOW_START, sessionIds: ['s1'] });
  assert.equal(scan.eventNamesSeen, 30);
  assert.equal(scan.eventNames.length, 5);

  const missing = new ZcodeSessionLogScanner({ sessionLogDir: join(root, 'nope') })
    .scan({ sinceMs: WINDOW_START });
  assert.equal(missing.available, false);
});
