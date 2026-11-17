#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from './router/dispatcher.js';
import { registerDelegateTask } from './tools/delegateTask.js';
import { registerDelegateWrite } from './tools/delegateWrite.js';
import { registerPoolStatus } from './tools/poolStatus.js';
import { log } from './utils/logger.js';

// The MCP client's cwd is the user's project, so also read the worker's own .env.
// loadEnvFile never overrides variables the client already set.
for (const file of [undefined, join(findProjectRoot(dirname(fileURLToPath(import.meta.url))), '.env')]) {
  try {
    process.loadEnvFile?.(file);
  } catch {
    // .env is optional
  }
}

const server = new McpServer({ name: 'free-pool-worker', version: '0.1.0' });
registerDelegateTask(server);
registerDelegateWrite(server);
registerPoolStatus(server);

await server.connect(new StdioServerTransport());
log('free-pool-worker ready on stdio');
