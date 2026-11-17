import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poolStatus, runDelegation } from '../src/router/dispatcher.js';
import { KeyRotator } from '../src/router/keyRotator.js';

test('the rotator walks to the next live key', () => {
  const rotator = new KeyRotator(['a', 'b']);

  assert.equal(rotator.current(), 'a');
  rotator.killCurrent();
  assert.equal(rotator.available, 1);
  assert.equal(rotator.current(), 'b');
  rotator.killCurrent();
  assert.equal(rotator.current(), null);
  assert.equal(rotator.available, 0);
});

test('rotate cycles through the keys', () => {
  const rotator = new KeyRotator(['a', 'b', 'c']);

  assert.equal(rotator.rotate(), 'b');
  assert.equal(rotator.rotate(), 'c');
  assert.equal(rotator.rotate(), 'a');
});

const dir = mkdtempSync(join(tmpdir(), 'free-pool-keys-'));
const configPath = join(dir, 'providers.json');

const provider = (id: string, envKeys: string) => ({
  id,
  base_url: `https://${id}.test/v1`,
  models: ['m1'],
  env_keys: envKeys,
  max_context: 100_000,
  max_output: 500,
});

writeFileSync(
  configPath,
  JSON.stringify({
    version: 1,
    providers: [provider('limited', 'FP_KEYS_A'), provider('revoked', 'FP_KEYS_B')],
    routing: { coding: ['limited'], tests: ['revoked'], docs: [], analysis: [], refactor: [] },
  }),
);

process.env.FREE_POOL_CONFIG = configPath;
process.env.FREE_POOL_STATE = join(dir, 'state.json');
process.env.FP_KEYS_A = 'a1,a2';
process.env.FP_KEYS_B = 'b1,b2';

const answers: Record<string, string> = {
  'Bearer a2': 'answer a2',
  'Bearer b2': 'answer b2',
};
const authorizations: string[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const auth = String((init?.headers as Record<string, string>)?.authorization ?? '');
  authorizations.push(auth);

  if (auth === 'Bearer a1') {
    return new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { 'retry-after': '1' } });
  }
  if (auth === 'Bearer b1') {
    return new Response('{"error":{"message":"invalid key"}}', { status: 401 });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: answers[auth] ?? 'unexpected' } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

test('a 429 on the first key retries with the second key', async () => {
  const result = await runDelegation({ task_type: 'coding', role_instruction: 'w', task_description: 'x' });

  assert.equal(result.content, 'answer a2');
  assert.equal(result.attempts.length, 1, 'the 429 is logged once');
  assert.equal(result.attempts[0].status, 'http');
  assert.deepEqual(authorizations, ['Bearer a1', 'Bearer a2']);

  const status = poolStatus() as {
    providers: Array<{ id: string; models: Array<{ state: string }> }>;
  };
  const limited = status.providers.find((entry) => entry.id === 'limited')!;
  assert.equal(limited.models[0].state, 'closed', 'another key worked, so no cooldown');
});

test('a 401 on the first key drops the key instead of failing the provider', async () => {
  authorizations.length = 0;

  const result = await runDelegation({ task_type: 'tests', role_instruction: 'w', task_description: 'x' });

  assert.equal(result.content, 'answer b2');
  assert.deepEqual(authorizations, ['Bearer b1', 'Bearer b2']);

  const status = poolStatus() as {
    providers: Array<{ id: string; state: string; disabled: string | null; keys_available: number }>;
  };
  const revoked = status.providers.find((entry) => entry.id === 'revoked')!;
  assert.equal(revoked.disabled, null, 'the provider still has a live key');
  assert.equal(revoked.state, 'closed');
  assert.equal(revoked.keys_available, 1, 'only the invalid key was killed');
});

test('cleanup', () => {
  rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});
