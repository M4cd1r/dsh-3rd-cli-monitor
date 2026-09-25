// test/cli.test.mjs — the standalone CLI drives the same application code,
// honors the state root, and keeps its usage contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileRunStore } from '../src/storage/file-run-store.mjs';
import { AdapterRegistry } from '../src/adapters/registry.mjs';
import { MonitorService } from '../src/application/monitor-service.mjs';
import { ZcodeCliAdapter } from '../src/adapters/zcode/adapter.mjs';
import { fakeClock, makeTempRoot, writeRunDir } from './helpers/fixtures.mjs';

const CLI = fileURLToPath(new URL('../bin/dsh-3rd-cli-monitor.mjs', import.meta.url));
const T0 = fakeClock().nowMs;
const START = T0 - 120_000;

function runCli(args, stateRoot) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_3RD_CLI_MONITOR_STATE_ROOT: stateRoot },
    timeout: 30_000,
  });
}

function seedState(t, root) {
  const logsDir = join(root, 'logs');
  writeRunDir(logsDir, {
    startedMs: START,
    slug: 'cli-seen',
    outText: 'work\n',
    mtimeMs: T0 - 1000,
    report: {
      status: 'ok', errorKind: null, model: 'GLM-5.3-Flash', modelsUsed: ['GLM-5.3-Flash'],
      modelVerification: 'ok', durationMs: 42_000, response: 'final response text',
      changedFiles: [], fallbackContext: { brief: 'secret', partialState: null, logRefs: {} },
    },
  });
  const clock = fakeClock(T0);
  const adapter = new ZcodeCliAdapter({
    clock,
    logsDirs: [logsDir],
    rolloutDir: join(root, 'rollout'),
    sessionLogDir: join(root, 'zlog'),
  });
  const store = new FileRunStore({ stateRoot: join(root, 'state'), clock });
  const registry = new AdapterRegistry();
  registry.register(adapter);
  const service = new MonitorService({ registry, getActiveCli: () => 'zcode', store, clock });
  return service.pollOnce();
}

test('status --json reports the aggregate from the shared state root', async (t) => {
  const root = makeTempRoot(t);
  const pollResult = await seedState(t, root);
  const runId = `${new Date(START).toISOString().replace(/[:.]/g, '-')}-cli-seen`;
  assert.equal(pollResult.discovered, 1);

  const result = runCli(['status', '--json'], join(root, 'state'));
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.cliId, 'zcode');
  assert.equal(parsed.totals.finished, 1);
  assert.equal(parsed.runs[0].runId, runId);
  assert.ok(!result.stdout.includes('secret'), 'no prompt text in CLI output');
});

test('human-readable status and runs include state and diagnostics', (t) => {
  const root = makeTempRoot(t);
  seedState(t, root);
  const status = runCli(['status'], join(root, 'state'));
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /zcode — 1 run\(s\)/);
  assert.match(status.stdout, /\[finished\]/);

  const runs = runCli(['runs', '--limit', '5'], join(root, 'state'));
  assert.equal(runs.status, 0, runs.stderr);
  assert.match(runs.stdout, /\[finished\]/);
});

test('events prints the recorded transitions for a run', (t) => {
  const root = makeTempRoot(t);
  seedState(t, root);
  const runId = `${new Date(START).toISOString().replace(/[:.]/g, '-')}-cli-seen`;
  const result = runCli(['events', '--run', runId], join(root, 'state'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /run\.discovered/);
});

test('use switches the active CLI and rejects unknown ids', (t) => {
  const root = makeTempRoot(t);
  seedState(t, root);
  const ok = runCli(['use', 'zcode'], join(root, 'state'));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /active CLI: zcode/);

  const bad = runCli(['use', 'ghost'], join(root, 'state'));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown CLI/);
});

test('watch --once prints observed transitions and exits 0', (t) => {
  const root = makeTempRoot(t);
  seedState(t, root);
  const result = runCli(['watch', '--once', '--state-root', join(root, 'state')], join(root, 'state'));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /-> finished/);
});

test('unknown flags exit 2 with usage; missing state root reads as empty', (t) => {
  const root = makeTempRoot(t);
  const bad = runCli(['status', '--nope'], join(root, 'state'));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown flag/);

  const empty = runCli(['status', '--json'], join(root, 'never-seen'));
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(JSON.parse(empty.stdout).runs.length, 0);
});

test('--help and --version work without a state root', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /read-only monitor/);
});
