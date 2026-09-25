// test/packaging.test.mjs — repository/packaging contract: package metadata,
// the cordis patch row, the plugin manifest, and shipped doc files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('package.json carries the required public metadata', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, '@m4cd1r/dsh-3rd-cli-monitor');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.engines, { node: '>=22.19.0' });
  assert.equal(pkg.repository.url, 'git+https://github.com/M4cd1r/dsh-3rd-cli-monitor.git');
  assert.match(pkg.scripts.test, /node --test/);
  assert.equal(pkg.bin['dsh-3rd-cli-monitor'], 'bin/dsh-3rd-cli-monitor.mjs');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(pkg.dsh.engines.dsh, 'declares a DSH engine range');
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies');
  for (const peer of Object.values(pkg.peerDependenciesMeta ?? {})) {
    assert.equal(peer.optional, true, 'peer packages are optional');
  }
});

test('every entry in package.json files[] exists', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const rel of pkg.files) {
    assert.ok(existsSync(join(root, rel)), `missing packaged file: ${rel}`);
  }
});

test('cordis.patch.yml inserts the plugin row with safe defaults', () => {
  const patch = read('cordis.patch.yml');
  assert.match(patch, /-\s+insert:/);
  assert.match(patch, /id:\s*third-cli-monitor/);
  assert.match(patch, /name:\s*['"]@m4cd1r\/dsh-3rd-cli-monitor['"]\s*$/m);
  assert.match(patch, /activeCli:\s*zcode/);
  // The patch must not carry secrets or absolute paths.
  assert.ok(!/[A-Za-z]:\\/.test(patch), 'no Windows absolute paths in the patch');
});

test('dsh.plugin.json matches the shipped entry point and engines', () => {
  const manifest = JSON.parse(read('dsh.plugin.json'));
  assert.equal(manifest.main, './src/host/plugin.mjs');
  assert.equal(manifest.id, 'third-cli-monitor');
  assert.equal(manifest.engines.dsh, '>=0.1.7-rc.1');
  assert.ok(existsSync(join(root, manifest.main)), 'entry point exists');
});

test('LICENSE is MIT and README/SKILL/docs ship the required surfaces', () => {
  assert.match(read('LICENSE'), /MIT License/);
  assert.match(read('README.md'), /read-only/i);
  assert.match(read('README.md'), /non-goals|Non-goals/i);
  assert.match(read('SKILL.md'), /never start/i);
  for (const doc of ['docs/architecture.md', 'docs/adapter-contract.md', 'docs/operations.md']) {
    assert.ok(existsSync(join(root, doc)), `missing ${doc}`);
  }
});

test('no committed secrets or bulky artifacts in tracked source', () => {
  const gitignore = read('.gitignore');
  assert.match(gitignore, /node_modules/);
  const config = read('src/config.mjs');
  assert.ok(!/api[_-]?key|secret|password/i.test(config.replace(/credentials/g, '')), 'no credential literals in config');
});
