import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createBaseRegistry } from '../context/registry.js';
import { getGraphStore } from '../shared/graphstore.js';
import { registerUpdateDescription } from './tools/update-description.js';
import type { McpInstanceContext } from './instance-context.js';
import type { ContextFunction } from '../context/types.js';
import { logger } from '../shared/logger.js';

/**
 * Register a ContextFunction as an MCP tool.
 * Bridges the ContextFunction interface to the MCP server.tool() API.
 */
function registerContextFn(server: McpServer, fn: ContextFunction): void {
  server.tool(
    fn.name,
    fn.description,
    fn.schema,
    async (input) => {
      const store = await getGraphStore();
      try {
        const result = await fn.execute(input as Record<string, unknown>, store);

        // Handle entity_summary special case: formatted markdown output
        if (fn.name === 'get_entity_summary' && result && typeof result === 'object' && 'error' in result) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            isError: true,
          };
        }
        if (fn.name === 'get_entity_summary' && result && typeof result === 'object' && 'formatted' in result) {
          return {
            content: [{ type: 'text' as const, text: (result as { formatted: string }).formatted }],
          };
        }

        // Handle ingest_memory special case: plain text response
        if (fn.name === 'ingest_memory' && result && typeof result === 'object' && 'message' in result) {
          const r = result as { message: string; topics: string; sourceId: string };
          return {
            content: [{ type: 'text' as const, text: `${r.message}\nTopics: ${r.topics}\nSource ID: ${r.sourceId}` }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );
}

/**
 * Create the MCP server, optionally scoped to an instance context.
 * When ctx is provided, only that instance's active functions are registered.
 * When ctx is null, all base functions are registered (backward-compatible).
 */
export async function createServer(ctx?: McpInstanceContext | null): Promise<McpServer> {
  const serverName = ctx ? `brainifai-${ctx.instanceName}` : 'brainifai-pkg';
  const server = new McpServer({
    name: serverName,
    version: '0.1.0',
  });

  const registry = await createBaseRegistry();

  // Register context functions — filtered by instance or all
  const activeFunctions = ctx
    ? registry.forInstance(ctx.activeFunctions)
    : registry.list();

  for (const fn of activeFunctions) {
    registerContextFn(server, fn);
  }

  // Always register infrastructure tools (not context functions)
  registerUpdateDescription(server);

  // If instance has a parent, register broader context tool for tree queries
  if (ctx?.parentName) {
    const broaderFn = registry.get('get_broader_context');
    if (broaderFn && !activeFunctions.some((f) => f.name === 'get_broader_context')) {
      registerContextFn(server, broaderFn);
      activeFunctions.push(broaderFn);
    }
  }

  logger.info(
    { server: serverName, tools: activeFunctions.map((f) => f.name) },
    'MCP server created with context functions',
  );

  return server;
}
