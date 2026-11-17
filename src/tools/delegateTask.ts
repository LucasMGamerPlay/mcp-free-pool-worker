import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runDelegation } from '../router/dispatcher.js';
import { fail, fallbackNote, ok } from './response.js';

const PREVIEW_LINES = 30;

export const delegateShape = {
  task_type: z
    .enum(['coding', 'tests', 'docs', 'analysis', 'refactor'])
    .describe('Routes the task to the right provider order (coding/tests are speed-first, analysis is context-first).'),
  role_instruction: z.string().min(1).describe('Worker persona, e.g. "Senior TypeScript engineer who writes Vitest suites".'),
  task_description: z.string().min(1).describe('Exact, narrow instruction of what to produce.'),
  context_files: z
    .array(z.string())
    .default([])
    .describe('Paths relative to WORKSPACE_ROOT. The server reads them from disk, so never paste file contents here.'),
  deadline_ms: z.number().int().positive().max(300_000).optional().describe('Total budget for the whole fallback loop. Default 90000.'),
  max_output_tokens: z.number().int().positive().max(16_000).optional(),
};

export function registerDelegateTask(server: McpServer): void {
  server.registerTool(
    'delegate_task',
    {
      description:
        'Delegate a mechanical subtask to the free/local model pool. The server reads context files from disk, fails over across providers, and returns a short preview plus a temp file path with the full output.',
      inputSchema: delegateShape,
    },
    async (args) => {
      try {
        const result = await runDelegation(args);
        const lines = result.content.split('\n').length;
        const preview = result.content.split('\n').slice(0, PREVIEW_LINES).join('\n');
        const file = join(tmpdir(), `free-pool-${randomUUID()}.txt`);
        await writeFile(file, result.content, 'utf8');
        return ok(
          `provider: ${result.provider} | model: ${result.model} | lines: ${lines}${fallbackNote(result.attempts)}\n` +
            `full output: ${file}\n\n` +
            `--- preview (first ${PREVIEW_LINES} lines) ---\n${preview}`,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );
}
