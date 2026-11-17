import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { poolStatus } from '../router/dispatcher.js';
import { ok } from './response.js';

export function registerPoolStatus(server: McpServer): void {
  server.registerTool(
    'worker_pool_status',
    {
      description:
        'Live state of the provider pool: circuit breaker state, cooldown remaining, keys left, and tokens saved this session.',
      inputSchema: {},
    },
    () => ok(JSON.stringify(poolStatus(), null, 2)),
  );
}
