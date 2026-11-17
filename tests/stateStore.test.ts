import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadState, saveState } from '../src/router/stateStore.js';

const dir = mkdtempSync(join(tmpdir(), 'free-pool-state-'));
const path = join(dir, 'nested', 'state.json');

test('round-trips breaker state and creates missing directories', () => {
  assert.equal(loadState(path), null);
  saveState({ version: 1, providers: { groq: { failures: 2, openUntil: 1234 } }, models: {} }, path);
  assert.deepEqual(loadState(path), {
    version: 1,
    providers: { groq: { failures: 2, openUntil: 1234 } },
    models: {},
  });
});

test('ignores corrupted or foreign state files', () => {
  writeFileSync(path, 'not json');
  assert.equal(loadState(path), null);

  writeFileSync(path, JSON.stringify({ version: 2, providers: {} }));
  assert.equal(loadState(path), null);

  writeFileSync(path, JSON.stringify({ version: 1, providers: { p1: { failures: 0, openUntil: 0 } } }));
  assert.deepEqual(loadState(path)?.models, {}, 'old state files without models still load');

  rmSync(dir, { recursive: true, force: true });
});
