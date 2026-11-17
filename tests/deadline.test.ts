import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDelegation, poolStatus } from '../src/router/dispatcher.js';

const dir = mkdtempSync(join(tmpdir(), 'free-pool-deadline-'));
const configPath = join(dir, 'providers.json');

writeFileSync(
  configPath,
  JSON.stringify({
    version: 1,
    providers: [
      {
        id: 'slow',
        base_url: 'https://slow.test/v1',
        models: ['slow-model'],
        env_key: 'FP_DL_KEY',
        max_context: 100_000,
        max_output: 500,
      },
    ],
    routing: { coding: ['slow'], tests: [], docs: [], analysis: [], refactor: [] },
  }),
);

process.env.FREE_POOL_CONFIG = configPath;
process.env.FREE_POOL_STATE = join(dir, 'state.json');
process.env.FP_DL_KEY = 'k';

const originalFetch = globalThis.fetch;

// a provider that answers in 300ms and honours the abort signal, like a real fetch
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 300);
    init?.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
      },
      { once: true },
    );
  });
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

test('a call waiting in the provider queue still respects the request deadline', { timeout: 10_000 }, async () => {
  const request = { task_type: 'coding' as const, role_instruction: 'w', task_description: 'x', deadline_ms: 500 };

  const first = runDelegation({ ...request });
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the first request take the provider
  const second = runDelegation({ ...request });

  const [a, b] = await Promise.allSettled([first, second]);
  assert.equal(a.status, 'fulfilled', 'the first call fits in the budget');
  assert.equal(b.status, 'rejected', 'the queued call must not start a fresh 500ms window');
  assert.match(
    String((b as PromiseRejectedResult).reason),
    /timeout \(deadline exceeded\)/,
    'the attempt is reported as a budget problem, not as model slowness',
  );

  const status = poolStatus() as {
    providers: Array<{ models: Array<{ id: string; state: string }> }>;
  };
  assert.equal(
    status.providers[0].models[0].state,
    'closed',
    'running out of budget says nothing about the model, so no cooldown',
  );

  rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});
