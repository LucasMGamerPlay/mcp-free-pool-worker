import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validateContent } from '../src/utils/validator.js';

test('rejects invalid JSON', async () => {
  const result = await validateContent('package.json', '{ "a": 1, }');
  assert.equal(result.ok, false);
});

test('accepts valid JSON', async () => {
  const result = await validateContent('package.json', '{ "a": 1 }');
  assert.deepEqual(result, { ok: true });
});

test('rejects syntactically broken TypeScript', async () => {
  const result = await validateContent('broken.ts', 'export const value = {');
  assert.equal(result.ok, false);
});

test('accepts valid TypeScript', async () => {
  const result = await validateContent('ok.ts', 'export const value: number = 1;\n');
  assert.equal(result.ok, true);
});

test('rejects broken YAML and accepts a real one', async () => {
  const broken = await validateContent('ci.yml', 'jobs:\n  test:\n    steps:\n      - run: "npm test\n');
  assert.equal(broken.ok, false);
  assert.match(broken.message ?? '', /invalid YAML/);

  const valid = await validateContent('ci.yml', 'jobs:\n  test:\n    steps:\n      - run: npm test\n');
  assert.deepEqual(valid, { ok: true });
});

test('rejects broken Python when an interpreter is available', async (t) => {
  let python: string | null = null;
  for (const candidate of [process.env.PYTHON?.trim(), 'python', 'python3'].filter(Boolean) as string[]) {
    try {
      execFileSync(candidate, ['-c', 'import ast'], { stdio: 'ignore' });
      python = candidate;
      break;
    } catch {
      // not installed
    }
  }
  if (!python) {
    t.skip('no python interpreter on this machine');
    return;
  }

  const broken = await validateContent('x.py', 'def f(:\n    pass\n');
  assert.equal(broken.ok, false);
  assert.match(broken.message ?? '', /invalid Python/);

  const valid = await validateContent('x.py', 'def f():\n    return 1\n');
  assert.deepEqual(valid, { ok: true });
});

test('skips file types it cannot check', async () => {
  const result = await validateContent('notes.md', '# anything');
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);

  const sql = await validateContent('query.sql', 'SELEC broken');
  assert.equal(sql.skipped, true, 'no SQL parser: say so instead of guessing');
});
