// scripts/check-syntax.mjs — `node --check` for every shipped JS file.
// Cross-platform replacement for shell globs in npm scripts.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skipDirs = new Set(['node_modules', '.git', 'test', 'coverage', 'dist', 'lib']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(full, out);
      continue;
    }
    if (entry.name.endsWith('.mjs') || entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [
  ...walk(join(root, 'src')),
  ...walk(join(root, 'bin')),
  ...walk(join(root, 'scripts')),
];
// Test files are checked too: syntax errors there fail the test run anyway,
// but a check-only pass should still see them.
const testDir = join(root, 'test');
try {
  files.push(...walk(testDir));
} catch {
  // no test directory (not yet created or packaged without tests)
}

const failures = [];
for (const file of files) {
  if (statSync(file).size === 0) continue;
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failures.push({ file, stderr: result.stderr });
  }
}

for (const failure of failures) {
  console.error(`SYNTAX FAIL: ${failure.file}`);
  console.error(failure.stderr);
}
console.log(`checked ${files.length} file(s), ${failures.length} failure(s)`);
process.exit(failures.length > 0 ? 1 : 0);
