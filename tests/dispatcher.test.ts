import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDelegation } from '../src/router/dispatcher.js';
import { fallbackNote } from '../src/tools/response.js';

const dir = mkdtempSync(join(tmpdir(), 'free-pool-test-'));
const configPath = join(dir, 'providers.json');

writeFileSync(
  configPath,
  JSON.stringify({
    version: 1,
    providers: [
      {
        id: 'p1',
        base_url: 'https://p1.test/v1',
        models: ['m1'],
        env_key: 'FP_TEST_KEY1',
        max_context: 100_000,
        max_output: 512,
      },
      {
        id: 'p2',
        base_url: 'https://p2.test/v1',
        models: ['m2'],
        env_key: 'FP_TEST_KEY2',
        max_context: 100_000,
        max_output: 512,
      },
    ],
    routing: { coding: ['p1', 'p2'], tests: [], docs: [], analysis: [], refactor: [] },
  }),
);

process.env.FREE_POOL_CONFIG = configPath;
process.env.FREE_POOL_STATE = join(dir, 'state.json');
process.env.FP_TEST_KEY1 = 'key1';
process.env.FP_TEST_KEY2 = 'key2';

test('falls over to the next provider when the first one is rate limited', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('p1.test')) {
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: 'done by p2' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const result = await runDelegation({
      task_type: 'coding',
      role_instruction: 'worker',
      task_description: 'say something',
      context_files: [],
    });

    assert.equal(result.provider, 'p2');
    assert.equal(result.content, 'done by p2');
    assert.equal(result.attempts[0].provider, 'p1');
    assert.equal(result.attempts[0].status, 'http');
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fails with a summary when every provider fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;

  try {
    await assert.rejects(
      runDelegation({
        task_type: 'coding',
        role_instruction: 'worker',
        task_description: 'say something',
        context_files: [],
        deadline_ms: 5_000,
      }),
      /no provider completed the task/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the fallback note separates real failures from skips', () => {
  assert.equal(fallbackNote([]), '');
  assert.equal(fallbackNote([{ status: 'http' }]), ' | fell back after 1 failed attempt(s)');
  assert.equal(
    fallbackNote([{ status: 'http' }, { status: 'no-key' }, { status: 'cooldown' }]),
    ' | fell back after 1 failed attempt(s) and 2 provider(s) skipped',
  );
  assert.equal(fallbackNote([{ status: 'context' }]), ' | fell back after 1 provider(s) skipped');
});
