import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poolStatus, runDelegation } from '../src/router/dispatcher.js';

const dir = mkdtempSync(join(tmpdir(), 'free-pool-models-'));
const configPath = join(dir, 'providers.json');

const provider = (id: string, host: string, models: string[]) => ({
  id,
  base_url: `https://${host}/v1`,
  models,
  env_key: 'FP_MODEL_KEY',
  max_context: 100_000,
  max_output: 500,
});

writeFileSync(
  configPath,
  JSON.stringify({
    version: 1,
    providers: [
      provider('rotator', 'rot.test', ['bad', 'good']),
      provider('net', 'net.test', ['netmodel']),
      provider('format', 'format.test', ['junk', 'fine']),
      provider('long', 'long.test', ['cut', 'fits']),
      provider('backup', 'backup.test', ['ok']),
    ],
    routing: { coding: ['rotator'], tests: ['net', 'backup'], docs: ['net'], analysis: ['long'], refactor: ['format'] },
  }),
);

process.env.FREE_POOL_CONFIG = configPath;
process.env.FREE_POOL_STATE = join(dir, 'state.json');
process.env.FP_MODEL_KEY = 'k';

const calls: string[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const model = JSON.parse(String(init?.body)).model as string;
  calls.push(`${url} ${model}`);

  if (url.includes('rot.test') && model === 'bad') {
    return new Response('model rate limited', { status: 429, headers: { 'retry-after': '30' } });
  }
  if (url.includes('net.test')) throw new TypeError('fetch failed');
  if (url.includes('format.test')) {
    const content = model === 'junk' ? 'BROKEN {{{' : 'ok fine';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (url.includes('long.test')) {
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: model === 'cut' ? 'partial code' : 'ok fits' }, finish_reason: model === 'cut' ? 'length' : 'stop' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: `ok ${model}` } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

test('a rate-limited model does not take down the rest of the provider', async () => {
  const result = await runDelegation({
    task_type: 'coding',
    role_instruction: 'worker',
    task_description: 'do it',
  });

  assert.equal(result.provider, 'rotator');
  assert.equal(result.model, 'good');
  assert.equal(result.content, 'ok good');
  assert.equal(result.attempts[0].model, 'bad');
  assert.equal(result.attempts[0].status, 'http');

  const status = poolStatus() as {
    providers: Array<{ id: string; state: string; models: Array<{ id: string; state: string; cooldown_ms: number }> }>;
  };
  const rotator = status.providers.find((entry) => entry.id === 'rotator')!;
  assert.equal(rotator.state, 'closed');
  assert.equal(rotator.models.find((model) => model.id === 'bad')!.state, 'open');
  assert.ok(rotator.models.find((model) => model.id === 'bad')!.cooldown_ms > 0);
  assert.equal(rotator.models.find((model) => model.id === 'good')!.state, 'closed');
});

test('a network failure cools the provider and fails over to the next one', async () => {
  const result = await runDelegation({
    task_type: 'tests',
    role_instruction: 'worker',
    task_description: 'do it',
  });

  assert.equal(result.provider, 'backup');
  assert.equal(result.attempts[0].status, 'network');

  const status = poolStatus() as { providers: Array<{ id: string; state: string }> };
  assert.equal(status.providers.find((entry) => entry.id === 'net')!.state, 'open');
});

test('output that fails validation is discarded and the next model is tried', async () => {
  const result = await runDelegation({
    task_type: 'refactor',
    role_instruction: 'worker',
    task_description: 'do it',
    validate: async (content) => ({ ok: !content.includes('BROKEN'), message: 'syntax error' }),
  });

  assert.equal(result.model, 'fine');
  assert.equal(result.content, 'ok fine');
  assert.equal(result.attempts[0].status, 'invalid');

  const status = poolStatus() as {
    providers: Array<{ id: string; models: Array<{ id: string; state: string }> }>;
  };
  const format = status.providers.find((entry) => entry.id === 'format')!;
  assert.equal(format.models.find((model) => model.id === 'junk')!.state, 'closed', 'a bad answer is not a cooldown');
});

test('a truncated answer is never accepted and the next model is tried', async () => {
  const result = await runDelegation({
    task_type: 'analysis',
    role_instruction: 'worker',
    task_description: 'do it',
  });

  assert.equal(result.model, 'fits');
  assert.equal(result.content, 'ok fits');
  assert.equal(result.attempts[0].status, 'truncated');

  const status = poolStatus() as {
    providers: Array<{ id: string; state: string; models: Array<{ id: string; state: string }> }>;
  };
  const long = status.providers.find((entry) => entry.id === 'long')!;
  assert.equal(long.state, 'closed', 'a cut-off answer is not a provider failure');
  assert.equal(long.models.find((model) => model.id === 'cut')!.state, 'closed', 'nor a model cooldown');
});

test('a cooled provider is skipped without another request', async () => {
  const before = calls.filter((call) => call.includes('net.test')).length;

  await assert.rejects(
    runDelegation({ task_type: 'docs', role_instruction: 'worker', task_description: 'do it', deadline_ms: 5_000 }),
    /net\/-: cooldown/,
  );

  assert.equal(calls.filter((call) => call.includes('net.test')).length, before, 'no request was sent');
  rmSync(dir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});
