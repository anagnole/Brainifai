// ─── Context Function abstraction ────────────────────────────────────────────

import type { z } from 'zod';
import type { GraphStore } from '../graphstore/types.js';

/**
 * A composable, registerable unit of context retrieval.
 * Wraps existing query logic into a uniform interface that any instance can use.
 */
export interface ContextFunction {
  name: string;                           // e.g., "search_entities"
  description: string;                    // human-readable, used for MCP tool description
  schema: Record<string, z.ZodTypeAny>;   // input schema (zod) — matches MCP server.tool() shape
  execute(input: Record<string, unknown>, store: GraphStore): Promise<unknown>;
}

/**
 * Registry for context functions — register, resolve, filter by instance.
 */
export interface ContextFunctionRegistry {
  register(fn: ContextFunction): void;
  get(name: string): ContextFunction | undefined;
  list(): ContextFunction[];
  listNames(): string[];
  /** Return only the functions active for a given instance */
  forInstance(activeNames: string[]): ContextFunction[];
}
