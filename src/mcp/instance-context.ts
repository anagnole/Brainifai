// ─── Resolve instance context for MCP server ────────────────────────────────

import { resolveInstancePath, readInstanceConfig, globalInstanceExists, GLOBAL_BRAINIFAI_PATH } from '../instance/resolve.js';
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
 * Falls back to null if no instance config is found (pre-multi-instance setup).
 */
export function resolveMcpContext(): McpInstanceContext | null {
  try {
    const instancePath = resolveInstancePath();

    // Check if the config file actually exists
    let config;
    try {
      config = readInstanceConfig(instancePath);
    } catch {
      // No config found — pre-multi-instance setup
      return null;
    }

    const activeFunctions = resolveContextFunctions(config);

    logger.info(
      { instance: config.name, type: config.type, functions: activeFunctions.length },
      'Resolved MCP instance context',
    );

    return {
      instanceName: config.name,
      instanceType: config.type,
      description: config.description,
      dbPath: instancePath,
      activeFunctions,
      parentName: config.parent,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve MCP instance context, using defaults');
    return null;
  }
}
