// ─── Resolve instance context for MCP server ────────────────────────────────

import { resolveInstance } from '../instance/resolve.js';
import { resolveContextFunctions } from '../context/resolve.js';
import { logger } from '../shared/logger.js';

export interface McpInstanceContext {
  instanceName: string;
  instanceType: string;
  description: string;
  dbPath: string;
  activeFunctions: string[];
  parentName: string | null;
}

/**
 * Resolve the MCP instance context from the current working directory.
 * Falls back to null if no instance is resolved.
 */
export function resolveMcpContext(): McpInstanceContext | null {
  try {
    const resolved = resolveInstance();
    const activeFunctions = resolveContextFunctions(resolved.config);

    logger.info(
      { instance: resolved.config.name, type: resolved.config.type, functions: activeFunctions.length },
      'Resolved MCP instance context',
    );

    return {
      instanceName: resolved.config.name,
      instanceType: resolved.config.type,
      description: resolved.config.description,
      dbPath: resolved.dbPath,
      activeFunctions,
      parentName: resolved.config.parent,
    };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Failed to resolve MCP instance context');
    return null;
  }
}
