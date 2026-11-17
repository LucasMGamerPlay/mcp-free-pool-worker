import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poolStatus } from '../src/router/dispatcher.js';

const dir = mkdtempSync(join(tmpdir(), 'free-pool-config-'));
let counter = 0;
process.env.FREE_POOL_STATE = join(dir, 'state.json');

function useConfig(config: unknown): void {
  const path = join(dir, `providers-${counter++}.json`);
  writeFileSync(path, typeof config === 'string' ? config : JSON.stringify(config));
  process.env.FREE_POOL_CONFIG = path;
}

const validProvider = {
  id: 'p1',
  base_url: 'https://p1.test/v1',
  models: ['m1'],
  env_key: 'FP_CONFIG_TEST_KEY',
  max_context: 1_000,
  max_output: 100,
};

test('rejects config that is not valid JSON', () => {
  useConfig('{ not json');
  assert.throws(() => poolStatus(), /not valid JSON/);
});

test('rejects a provider missing required fields', () => {
  useConfig({ version: 1, providers: [{ id: 'p1' }], routing: {} });
  assert.throws(() => poolStatus(), /max_context/);
});

test('rejects routing that points at an unknown provider', () => {
  useConfig({ version: 1, providers: [validProvider], routing: { coding: ['ghost'] } });
  assert.throws(() => poolStatus(), /unknown provider "ghost"/);
});

test('rejects duplicate provider ids', () => {
  useConfig({ version: 1, providers: [validProvider, validProvider], routing: {} });
  assert.throws(() => poolStatus(), /unique/);
});

test('accepts a valid config and caches it', () => {
  useConfig({ version: 1, providers: [validProvider], routing: { coding: ['p1'] } });
  const status = poolStatus() as { providers: Array<{ id: string }> };
  assert.equal(status.providers[0].id, 'p1');

  useConfig({ version: 1, providers: [], routing: {} });
  assert.equal((poolStatus() as { providers: unknown[] }).providers.length, 1, 'config is loaded once');

  rmSync(dir, { recursive: true, force: true });
});
