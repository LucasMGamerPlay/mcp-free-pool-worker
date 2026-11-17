import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runDelegation, workspaceRoot } from '../router/dispatcher.js';
import { normalizeOutput } from '../utils/codeFence.js';
import { safeResolve } from '../utils/safePath.js';
import { validateContent } from '../utils/validator.js';
import { delegateShape } from './delegateTask.js';
import { fail, fallbackNote, ok } from './response.js';

export function registerDelegateWrite(server: McpServer): void {
  server.registerTool(
    'delegate_and_write',
    {
      description:
        'Same as delegate_task, but the server validates the worker output and writes it to output_file_path. If the target exists and overwrite is false, the new content goes to <path>.bak and the original is left untouched.',
      inputSchema: {
        ...delegateShape,
        output_file_path: z.string().min(1).describe('Destination path relative to WORKSPACE_ROOT.'),
        overwrite: z.boolean().default(false).describe('Replace an existing file. Default false.'),
      },
    },
    async (args) => {
      const rejected: { output: { message?: string; preview: string } | null } = { output: null };
      try {
        // resolve before delegating: a blocked destination must not cost a model call
        const absolute = safeResolve(workspaceRoot(), args.output_file_path);
        const normalize = (raw: string) => normalizeOutput(args.output_file_path, raw);

        let validation: Awaited<ReturnType<typeof validateContent>> = { ok: true };
        const result = await runDelegation({
          ...args,
          validate: async (raw) => {
            const normalized = normalize(raw);
            validation = await validateContent(args.output_file_path, normalized);
            rejected.output = validation.ok
              ? null
              : { message: validation.message, preview: normalized.split('\n').slice(0, 20).join('\n') };
            return validation;
          },
        });
        const content = normalize(result.content);

        await mkdir(dirname(absolute), { recursive: true });

        const exists = await pathExists(absolute);
        const target = exists && !args.overwrite ? `${absolute}.bak` : absolute;
        await writeFile(target, content, 'utf8');

        const lines = content.split('\n').length;
        const warning =
          exists && !args.overwrite
            ? `warning: ${args.output_file_path} already exists; wrote the new content to ${args.output_file_path}.bak and left the original untouched (pass overwrite: true to replace).\n`
            : '';
        const validationNote = validation.skipped ? `skipped (${validation.message})` : 'ok';

        return ok(
          `${warning}ok: wrote ${lines} lines to ${target}\n` +
            `provider: ${result.provider} | model: ${result.model}${fallbackNote(result.attempts)}\n` +
            `validation: ${validationNote}`,
        );
      } catch (error) {
        if (!rejected.output) return fail(error);
        const message = error instanceof Error ? error.message : String(error);
        return fail(
          `${message}\n` +
            `nothing was written.\n\n` +
            `--- last rejected output (first 20 lines) ---\n${rejected.output.preview}`,
        );
      }
    },
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
