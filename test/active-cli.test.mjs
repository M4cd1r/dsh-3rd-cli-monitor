// test/active-cli.test.mjs — active CLI selection (required coverage area 8).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AdapterRegistry } from '../src/adapters/registry.mjs';
import { ActiveCliService } from '../src/application/active-cli.mjs';
import { fakeClock, makeTempRoot } from './helpers/fixtures.mjs';

function setup(t, { fileBody } = {}) {
  const root = makeTempRoot(t);
  const registry = new AdapterRegistry();
  registry.register({ id: 'zcode', displayName: 'ZCode', discoverRuns: () => [] });
  registry.register({ id: 'other', displayName: 'Other', discoverRuns: () => [] });
  if (fileBody !== undefined) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'active-cli.json'), fileBody);
  }
  const warnings = [];
  const activeCli = new ActiveCliService({
    stateRoot: root,
    registry,
    clock: fakeClock(),
    logger: { warn: (msg) => warnings.push(String(msg)) },
  });
  return { root, registry, activeCli, warnings };
}

test('defaults to zcode when nothing is persisted', (t) => {
  const { activeCli } = setup(t);
  assert.equal(activeCli.get(), 'zcode');
});

test('set() validates against the registry, persists, and reads back', (t) => {
  const { root, activeCli } = setup(t);
  assert.equal(activeCli.set('other'), 'other');
  const persisted = JSON.parse(readFileSync(join(root, 'active-cli.json'), 'utf8'));
  assert.equal(persisted.cliId, 'other');
  assert.equal(activeCli.get(), 'other');
  assert.throws(() => activeCli.set('nope'), RangeError);
  assert.throws(() => activeCli.set(''), /required/);
  // A rejected set leaves the previous selection in place.
  assert.equal(activeCli.get(), 'other');
});

test('a corrupt or unknown persisted value fails safe to the default', (t) => {
  const corrupt = setup(t, { fileBody: '{not json' });
  assert.equal(corrupt.activeCli.get(), 'zcode');

  const unknown = setup(t, { fileBody: '{"cliId":"ghost-cli"}' });
  assert.equal(unknown.activeCli.get(), 'zcode');
  assert.ok(unknown.warnings.some((w) => w.includes('ghost-cli')));
});

test('a persisted selection survives restarts (same state root, new instance)', (t) => {
  const { root, activeCli } = setup(t);
  activeCli.set('other');
  const revived = new ActiveCliService({
    stateRoot: root,
    registry: setup(t).registry,
    clock: fakeClock(),
  });
  assert.equal(revived.get(), 'other');
});
