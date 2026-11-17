import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poolStatus, runDelegation } from '../src/router/dispatcher.js';

const dir = mkdtempSync(join(tmpdir(), 'free-pool-dead-'));
const configPath = join(dir, 'providers.json');

writeFileSync(
  configPath,
  JSON.stringify({
    version: 1,
    providers: [
      {
        id: 'catalog',
        base_url: 'https://catalog.test/v1',
        models: ['gone', 'quota', 'payload', 'busy', 'alive'],
        env_key: 'FP_DEAD_KEY',
        max_context: 100_000,
        max_output: 500,
      },
    ],
    routing: { coding: ['catalog'], tests: [], docs: [], analysis: [], refactor: [] },
  }),
);

process.env.FREE_POOL_CONFIG = configPath;
process.env.FREE_POOL_STATE = join(dir, 'state.json');
process.env.FP_DEAD_KEY = 'k';

const requested: string[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const model = JSON.parse(String(init?.body)).model as string;
  requested.push(model);

  // the exact shape OpenRouter returns for a slug that does not exist
  if (model === 'gone') {
    return new Response('{"error":{"message":"gone is not a valid model ID","code":400}}', { status: 400 });
  }
  // an exhausted quota: a one minute retry would just hammer it
  if (model === 'quota') {
    return new Response('{"error":{"message":"quota exhausted for today"}}', { status: 402 });
  }
  // a payload problem: not the model's fault, so it must stay eligible
  if (model === 'payload') {
    return new Response('{"error":{"message":"max_tokens is too large for this request"}}', { status: 400 });
  }
  // transient wording: the model is fine, only busy right now
  if (model === 'busy') {
    return new Response('{"error":{"message":"model temporarily unavailable, please try again"}}', { status: 400 });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: 'ok alive' } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

test('a dead model id and an exhausted quota are cooled, a payload error is not', async () => {
  const first = await runDelegation({ task_type: 'coding', role_instruction: 'w', task_description: 'do it' });
  assert.equal(first.model, 'alive');
  assert.equal(first.attempts[0].status, 'http');

  const second = await runDelegation({ task_type: 'coding', role_instruction: 'w', task_description: 'do it' });
  assert.equal(second.model, 'alive');
  assert.equal(second.attempts[0].status, 'cooldown', 'the dead slug is skipped, not requested again');

  assert.deepEqual(requested, ['gone', 'quota', 'payload', 'busy', 'alive', 'payload', 'busy', 'alive']);

  const status = poolStatus() as {
    providers: Array<{ id: string; models: Array<{ id: string; state: string; cooldown_ms: number }> }>;
  };
  const models = status.providers[0].models;
  const gone = models.find((model) => model.id === 'gone')!;
  const quota = models.find((model) => model.id === 'quota')!;
  const payload = models.find((model) => model.id === 'payload')!;
  const busy = models.find((model) => model.id === 'busy')!;
  assert.equal(gone.state, 'open');
  assert.ok(gone.cooldown_ms > 60_000, 'a dead slug gets a long cooldown');
  assert.equal(quota.state, 'open', 'an exhausted quota is benched, not retried every minute');
  assert.ok(quota.cooldown_ms > 3_000_000, 'quota cooldown is about an hour');
  assert.equal(payload.state, 'closed', 'a payload error does not bench the model');
  assert.equal(payload.cooldown_ms, 0);
  assert.equal(busy.state, 'closed', 'a transient message does not bench the model for an hour');

  rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});
