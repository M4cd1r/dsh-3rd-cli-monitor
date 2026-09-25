// test/redaction.test.mjs — no prompt / reasoning / tool-output / response
// leakage anywhere in persisted state (required coverage area 3).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ZcodeCliAdapter } from '../src/adapters/zcode/adapter.mjs';
import { FileRunStore } from '../src/storage/file-run-store.mjs';
import { MonitorService } from '../src/application/monitor-service.mjs';
import { AdapterRegistry } from '../src/adapters/registry.mjs';
import { stripForbidden } from '../src/domain/redact.mjs';
import {
  SAMPLE_PROMPT,
  SAMPLE_RESPONSE,
  SAMPLE_REASONING,
  baseReport,
  fakeClock,
  makeTempRoot,
  writeRolloutEntries,
  writeRunDir,
} from './helpers/fixtures.mjs';

const T0 = fakeClock().nowMs;
const START = T0 - 5 * 60_000;

test('parsed snapshots never contain prompt, response, or reasoning text', (t) => {
  const root = makeTempRoot(t);
  const logsDir = join(root, 'logs');
  const rolloutDir = join(root, 'rollout');
  writeRunDir(logsDir, {
    startedMs: START,
    slug: 'sensitive',
    outText: `wrapper echoed: ${SAMPLE_RESPONSE}\n`,
    errText: '',
    mtimeMs: T0 - 1000,
    report: baseReport(),
  });
  writeRolloutEntries(rolloutDir, 'sess_x', [
    { atMs: START + 1000, model: 'GLM-5.3-Flash' },
  ]);

  const adapter = new ZcodeCliAdapter({
    clock: fakeClock(T0),
    logsDirs: [logsDir],
    rolloutDir,
    sessionLogDir: join(root, 'zlog'),
  });
  const runs = adapter.discoverRuns();
  assert.equal(runs.length, 1);
  const serialized = JSON.stringify(runs[0]);
  assert.ok(!serialized.includes(SAMPLE_PROMPT), 'prompt text leaked into snapshot');
  assert.ok(!serialized.includes(SAMPLE_RESPONSE), 'response text leaked into snapshot');
  assert.ok(!serialized.includes(SAMPLE_REASONING), 'reasoning text leaked into snapshot');
  assert.equal(runs[0].responsePresent, true, 'presence flag must survive while content does not');
  assert.ok(!('response' in runs[0]));
  assert.ok(!('brief' in runs[0]));
});

test('nothing sensitive lands in status.json or events.jsonl on disk', async (t) => {
  const root = makeTempRoot(t);
  const logsDir = join(root, 'logs');
  writeRunDir(logsDir, {
    startedMs: START,
    slug: 'disk',
    report: baseReport({ partialState: `run hit the timeout; logs show activity — ${SAMPLE_RESPONSE.slice(0, 30)}` }),
  });

  const clock = fakeClock(T0);
  const registry = new AdapterRegistry().register(new ZcodeCliAdapter({
    clock,
    logsDirs: [logsDir],
    rolloutDir: join(root, 'rollout'),
    sessionLogDir: join(root, 'zlog'),
  }));
  const store = new FileRunStore({ stateRoot: join(root, 'state'), clock });
  const service = new MonitorService({
    registry,
    getActiveCli: () => 'zcode',
    store,
    clock,
  });
  await service.pollOnce();

  const statusRaw = readFileSync(join(root, 'state', 'runs', 'zcode',
    `${new Date(START).toISOString().replace(/[:.]/g, '-')}-disk`, 'status.json'), 'utf8');
  assert.ok(!statusRaw.includes(SAMPLE_PROMPT), 'prompt leaked into status.json');
  assert.ok(!statusRaw.includes(SAMPLE_RESPONSE), 'response text leaked into status.json');

  await service.heartbeatOnce();
  const stateRootRaw = readFileSync(
    join(root, 'state', 'runs', 'zcode',
      `${new Date(START).toISOString().replace(/[:.]/g, '-')}-disk`, 'events.jsonl'), 'utf8');
  assert.ok(!stateRootRaw.includes(SAMPLE_PROMPT), 'prompt leaked into events.jsonl');
  assert.ok(!stateRootRaw.includes(SAMPLE_RESPONSE), 'response leaked into events.jsonl');
});

test('stripForbidden drops sensitive keys defensively, one level deep', () => {
  const dirty = {
    model: 'GLM-5.3-Flash',
    prompt: 'should vanish',
    Prompt: 'vanishes too (case-insensitive)',
    nested: { apiKey: 'sk-nope', startedAt: '2026-09-24T00:00:00Z', Authorization: 'Bearer x' },
    list: ['raw text stays — arrays are content, not metadata'],
  };
  const clean = stripForbidden(dirty);
  assert.equal(clean.prompt, undefined);
  assert.equal(clean.Prompt, undefined);
  assert.equal(clean.model, 'GLM-5.3-Flash');
  assert.equal(clean.nested.apiKey, undefined);
  assert.equal(clean.nested.Authorization, undefined);
  assert.equal(clean.nested.startedAt, '2026-09-24T00:00:00Z');
  assert.deepEqual(clean.list, ['raw text stays — arrays are content, not metadata']);
});
