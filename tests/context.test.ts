import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDelegation } from '../src/router/dispatcher.js';

const dir = mkdtempSync(join(tmpdir(), 'free-pool-context-'));
const configPath = join(dir, 'providers.json');

const provider = (id: string, maxContext: number) => ({
  id,
  base_url: `https://${id}.test/v1`,
  models: [`${id}-model`],
  env_key: 'FP_CTX_KEY',
  max_context: maxContext,
  max_output: 500,
});

writeFileSync(
  configPath,
  JSON.stringify({
    version: 1,
    providers: [provider('tiny', 1_000), provider('roomy', 100_000)],
    routing: { coding: ['tiny', 'roomy'], tests: [], docs: [], analysis: [], refactor: [] },
  }),
);

process.env.FREE_POOL_CONFIG = configPath;
process.env.FREE_POOL_STATE = join(dir, 'state.json');
process.env.FP_CTX_KEY = 'k';

const requested: string[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request) => {
  const host = new URL(String(input)).hostname;
  requested.push(host);
  return new Response(JSON.stringify({ choices: [{ message: { content: `${host} ok` } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

test('a provider must fit the input plus the requested output, not just the input', async () => {
  // 2802 chars ≈ 701 tokens of input, so the input alone fits in 1000
  const task = 'x'.repeat(2_800);

  const result = await runDelegation({
    task_type: 'coding',
    role_instruction: 'w',
    task_description: task,
    max_output_tokens: 500,
    deadline_ms: 20_000,
  });

  assert.equal(result.provider, 'roomy', 'the provider that cannot hold the answer is skipped');
  assert.equal(result.attempts[0].status, 'context');
  assert.match(result.attempts[0].detail ?? '', /^701\+500 > 1000$/);
  assert.deepEqual(requested, ['roomy.test'], 'no request was sent to the impossible provider');

  rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});
