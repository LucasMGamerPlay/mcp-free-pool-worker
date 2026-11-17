import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = mkdtempSync(join(tmpdir(), 'free-pool-e2e-'));
const configPath = join(root, 'providers.json');
const statePath = join(root, 'state.json');

interface ToolReply {
  content?: Array<{ text?: string }>;
  isError?: boolean;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolReply;
}

function textOf(result: ToolReply): string {
  return (result.content ?? []).map((block) => block.text ?? '').join('\n');
}

test('runs delegate_task and delegate_and_write end to end over stdio', { timeout: 30_000 }, async () => {
  const http = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      // the prompt decides what the fake worker answers
      const prompt = Buffer.concat(chunks).toString('utf8');
      const content = prompt.includes('BROKEN_OUTPUT') ? 'export const = ;' : '```ts\nexport const ok = 1;\n```';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;

  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: 'mock',
          base_url: `http://127.0.0.1:${port}/v1`,
          models: ['mock-model'],
          max_context: 100_000,
          max_output: 1_000,
        },
      ],
      routing: { coding: ['mock'], tests: ['mock'], docs: ['mock'], analysis: ['mock'], refactor: ['mock'] },
    }),
  );

  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string')) as Record<
    string,
    string
  >;
  env.FREE_POOL_CONFIG = configPath;
  env.FREE_POOL_STATE = statePath;
  env.WORKSPACE_ROOT = root;

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), 'dist', 'src', 'index.js')],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'e2e', version: '0.0.0' });
  await client.connect(transport);

  try {
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ['delegate_and_write', 'delegate_task', 'worker_pool_status'],
    );

    const delegated = await call(client, 'delegate_task', {
      task_type: 'coding',
      role_instruction: 'worker',
      task_description: 'write a line',
    });
    const delegatedText = textOf(delegated);
    assert.match(delegatedText, /provider: mock \| model: mock-model/);
    assert.match(delegatedText, /export const ok = 1;/);

    const written = await call(client, 'delegate_and_write', {
      task_type: 'coding',
      role_instruction: 'worker',
      task_description: 'write a line',
      output_file_path: 'generated/ok.ts',
    });
    assert.notEqual(written.isError, true, textOf(written));

    const file = join(root, 'generated', 'ok.ts');
    assert.equal(existsSync(file), true);
    assert.equal(readFileSync(file, 'utf8').trim(), 'export const ok = 1;');

    const again = await call(client, 'delegate_and_write', {
      task_type: 'coding',
      role_instruction: 'worker',
      task_description: 'write a line',
      output_file_path: 'generated/ok.ts',
    });
    assert.match(textOf(again), /already exists/);
    assert.equal(readFileSync(file, 'utf8').trim(), 'export const ok = 1;', 'original file untouched');
    assert.equal(readFileSync(`${file}.bak`, 'utf8').trim(), 'export const ok = 1;');

    const overwritten = await call(client, 'delegate_and_write', {
      task_type: 'coding',
      role_instruction: 'worker',
      task_description: 'write a line',
      output_file_path: 'generated/ok.ts',
      overwrite: true,
    });
    assert.match(textOf(overwritten), /ok: wrote/);
    assert.doesNotMatch(textOf(overwritten), /already exists/, 'overwrite replaces in place');

    const broken = await call(client, 'delegate_and_write', {
      task_type: 'coding',
      role_instruction: 'worker',
      task_description: 'BROKEN_OUTPUT',
      output_file_path: 'generated/broken.ts',
    });
    assert.equal(broken.isError, true, 'invalid syntax must fail the call');
    assert.match(textOf(broken), /every provider that answered produced unusable output/);
    assert.match(textOf(broken), /last rejected output/);
    assert.match(textOf(broken), /export const = ;/, 'the manager sees what the worker wrote');
    assert.equal(existsSync(join(root, 'generated', 'broken.ts')), false, 'nothing is written on failure');
    assert.equal(existsSync(join(root, 'generated', 'broken.ts.bak')), false, 'not even a backup');

    const statusReply = await call(client, 'worker_pool_status', {});
    const status = JSON.parse(textOf(statusReply)) as {
      providers: Array<{ state: string }>;
      stats: { delegated: number };
      routing: Record<string, string[]>;
      workspace_root: string;
      config_file: string;
      state_file: string;
    };
    assert.equal(status.providers[0].state, 'closed');
    assert.ok(status.stats.delegated >= 3, `delegated=${status.stats.delegated}`);
    assert.deepEqual(status.routing.coding, ['mock'], 'status exposes which providers serve each task type');
    assert.equal(status.workspace_root, root, 'status shows the root used to resolve paths');
    assert.equal(status.config_file, configPath, 'status shows which providers.json is loaded');
    assert.equal(status.state_file, statePath, 'status shows where cooldowns are persisted');
  } finally {
    await client.close();
    http.close();
    rmSync(root, { recursive: true, force: true });
  }
});
