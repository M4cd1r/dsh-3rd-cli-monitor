// test/zcode-adapter.test.mjs — report/log discovery and normalized snapshot
// parsing (required coverage area 1), plus missing-log fail-safety (area 9).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ZcodeCliAdapter } from '../src/adapters/zcode/adapter.mjs';
import {
  baseReport,
  fakeClock,
  makeTempRoot,
  writeRolloutEntries,
  writeRunDir,
  writeSessionEvents,
} from './helpers/fixtures.mjs';

function makeAdapter(t, { clock = fakeClock(), logsDir, rolloutDir, sessionLogDir, ...rest } = {}) {
  const root = logsDir ?? join(makeTempRoot(t), 'logs');
  return new ZcodeCliAdapter({
    clock,
    logsDirs: [root],
    rolloutDir: rolloutDir ?? join(root, '..', 'rollout'),
    sessionLogDir: sessionLogDir ?? join(root, '..', 'zlog'),
    ...rest,
  });
}

const T0 = fakeClock().nowMs; // a stable base instant
const START = T0 - 5 * 60_000; // run started 5 minutes before "now"

test('a finished run is discovered from report.json with bounded metadata', (t) => {
  const logsDir = join(makeTempRoot(t), 'logs');
  writeRunDir(logsDir, {
    startedMs: START,
    slug: 'my-task',
    mtimeMs: T0 - 1000,
    outText: 'wrapper output\n',
    errText: '',
    report: baseReport({ durationMs: 30_000 }),
  });
  const adapter = makeAdapter(t, { logsDir, clock: fakeClock(T0) });
  const runs = adapter.discoverRuns();
  assert.equal(runs.length, 1);
  const run = runs[0];
  assert.equal(run.runId, `${new Date(START).toISOString().replace(/[:.]/g, '-')}-my-task`);
  assert.equal(run.cliId, 'zcode');
  assert.equal(run.state, 'finished');
  assert.equal(run.exitKind, 'ok');
  assert.equal(run.responsePresent, true);
  assert.equal(run.durationMs, 30_000);
  assert.equal(run.changedFilesCount, 2);
  assert.deepEqual(run.modelsUsed, ['GLM-5.3-Flash']);
  assert.equal(run.model, 'GLM-5.3-Flash');
  assert.ok(run.diagnostics.some((d) => d.includes('response: present')));
  assert.equal(run.counts.modelRequests, 5);
  assert.equal(run.counts.emptyResponses, 1);
  assert.equal(run.counts.errors, 2);
  assert.ok(run.logPaths.report.endsWith('report.json'));
  assert.ok(run.logPaths.out.endsWith('out.log'));
});

test('errorKind maps to timed-out / failed / unknown states', (t) => {
  const logsDir = join(makeTempRoot(t), 'logs');
  writeRunDir(logsDir, {
    startedMs: START, slug: 'a', report: baseReport({ status: 'error', errorKind: 'timeout' }),
  });
  writeRunDir(logsDir, {
    startedMs: START + 1000, slug: 'b', report: baseReport({ status: 'error', errorKind: 'task-failed' }),
  });
  writeRunDir(logsDir, {
    startedMs: START + 2000, slug: 'c', report: baseReport({ status: 'unknown', errorKind: null }),
  });
  const runs = makeAdapter(t, { logsDir, clock: fakeClock(T0) }).discoverRuns();
  const bySlug = Object.fromEntries(runs.map((r) => [r.slug, r.state]));
  assert.equal(bySlug.a, 'timed-out');
  assert.equal(bySlug.b, 'failed');
  assert.equal(bySlug.c, 'unknown');
});

test('live runs map to running / waiting / orphaned / discovered by freshness and age', (t) => {
  const logsDir = join(makeTempRoot(t), 'logs');
  // Fresh write, started 2 min ago -> running.
  writeRunDir(logsDir, {
    startedMs: T0 - 2 * 60_000, slug: 'live', outText: 'work\n', mtimeMs: T0 - 1000,
  });
  // Quiet for 10 min, started 12 min ago -> waiting.
  writeRunDir(logsDir, {
    startedMs: T0 - 12 * 60_000, slug: 'quiet', outText: 'work\n', mtimeMs: T0 - 10 * 60_000,
  });
  // Started 40 min ago (beyond the 30-minute wrapper cap), no report -> orphaned.
  writeRunDir(logsDir, {
    startedMs: T0 - 40 * 60_000, slug: 'ghost', outText: 'work\n', mtimeMs: T0 - 39 * 60_000,
  });
  // Empty directory, nothing to classify -> discovered.
  writeRunDir(logsDir, { startedMs: T0 - 30_000, slug: 'bare' });

  const runs = makeAdapter(t, { logsDir, clock: fakeClock(T0) }).discoverRuns();
  const bySlug = Object.fromEntries(runs.map((r) => [r.slug, r.state]));
  assert.equal(bySlug.live, 'running');
  assert.equal(bySlug.quiet, 'waiting');
  assert.equal(bySlug.ghost, 'orphaned');
  assert.equal(bySlug.bare, 'discovered');
  const orphan = runs.find((r) => r.slug === 'ghost');
  assert.ok(orphan.diagnostics.some((d) => d.includes('30-minute cap')));
});

test('live run counts and sessionId come from rollout/session logs in the window', (t) => {
  const root = makeTempRoot(t);
  const logsDir = join(root, 'logs');
  const rolloutDir = join(root, 'rollout');
  const sessionLogDir = join(root, 'zlog');
  writeRunDir(logsDir, {
    startedMs: START, slug: 'worker', outText: 'work\n', mtimeMs: T0 - 1000,
  });
  writeRolloutEntries(rolloutDir, 'sess_one', [
    { atMs: START + 1000, model: 'GLM-5.3-Flash' },
    { atMs: START + 2000, model: 'GLM-5.3-Flash' },
    { atMs: START + 3000, model: 'GLM-5.3-Flash', empty: true },
  ]);
  writeSessionEvents(sessionLogDir, START + 1500, [
    { sessionId: 'sess_one', event: 'tool.call.started' },
    { sessionId: 'sess_one', event: 'tool.call.completed' },
    { sessionId: 'sess_one', event: 'tool.call.failed' },
  ]);
  const run = makeAdapter(t, { logsDir, rolloutDir, sessionLogDir, clock: fakeClock(T0) })
    .discoverRuns()[0];
  assert.equal(run.state, 'running');
  assert.equal(run.sessionId, 'sess_one');
  assert.equal(run.counts.modelRequests, 3);
  assert.equal(run.counts.modelResponses, 2);
  assert.equal(run.counts.emptyResponses, 1);
  assert.equal(run.counts.toolCallsCompleted, 1);
  assert.equal(run.counts.toolCallsFailed, 1);
});

test('ambiguous sessions in the window leave sessionId unattributed', (t) => {
  const root = makeTempRoot(t);
  const logsDir = join(root, 'logs');
  const rolloutDir = join(root, 'rollout');
  const sessionLogDir = join(root, 'zlog');
  writeRunDir(logsDir, { startedMs: START, slug: 'shared', outText: 'work\n', mtimeMs: T0 - 1000 });
  writeRolloutEntries(rolloutDir, 'sess_a', [{ atMs: START + 1000, model: 'm1' }]);
  writeRolloutEntries(rolloutDir, 'sess_b', [{ atMs: START + 1100, model: 'm2' }]);
  const run = makeAdapter(t, { logsDir, rolloutDir, sessionLogDir, clock: fakeClock(T0) })
    .discoverRuns()[0];
  assert.equal(run.sessionId, null);
  assert.ok(run.diagnostics.some((d) => d.includes('ambiguous session ids')));
});

test('directories that do not match the wrapper stamp are ignored', (t) => {
  const logsDir = join(makeTempRoot(t), 'logs');
  writeRunDir(logsDir, { startedMs: START, slug: 'ok' });
  const junk = join(logsDir, 'not-a-stamp-dir');
  mkdirSync(junk, { recursive: true });
  writeFileSync(join(junk, 'report.json'), '{}');
  const runs = makeAdapter(t, { logsDir, clock: fakeClock(T0) }).discoverRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].slug, 'ok');
});

test('missing or unreadable artifact locations fail safe', (t) => {
  const root = makeTempRoot(t);
  const missing = join(root, 'does-not-exist', 'logs');
  const adapter = makeAdapter(t, { logsDir: missing, clock: fakeClock(T0) });
  assert.deepEqual(adapter.discoverRuns(), []);

  // A run dir whose report.json is torn/garbage yields unknown, not a throw.
  const logsDir = join(root, 'logs');
  writeRunDir(logsDir, { startedMs: START, slug: 'torn', report: 'garbage' });
  const runs = new ZcodeCliAdapter({
    clock: fakeClock(T0),
    logsDirs: [logsDir],
    rolloutDir: join(root, 'rollout'),
    sessionLogDir: join(root, 'zlog'),
  }).discoverRuns();
  assert.equal(runs[0].state, 'unknown');
  assert.ok(runs[0].diagnostics.some((d) => d.includes('not valid JSON')));
});
