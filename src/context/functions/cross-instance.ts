import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import { queryParent } from '../tree-query.js';
import { resolveInstance } from '../../instance/resolve.js';
import { logger } from '../../shared/logger.js';

export const broaderContextFn: ContextFunction = {
  name: 'get_broader_context',
  description: 'Query the parent instance for broader context beyond this project — useful for cross-project connections and organizational context',
  schema: {
    query: z.string().describe('Natural language query to find relevant context for'),
    timeout_ms: z.number().int().min(1000).max(10000).default(5000)
      .describe('Maximum time to wait for parent response (ms)'),
  },
  async execute(input, _store) {
    const { query, timeout_ms } = input as { query: string; timeout_ms?: number };

    // Resolve current instance
    let instanceName: string;
    let instancePath: string;
    let parent: string | null;
    try {
      const resolved = resolveInstance();
      instanceName = resolved.config.name;
      instancePath = resolved.instancePath;
      parent = resolved.config.parent;

      if (!parent) {
        return { error: 'This is the root instance — no parent to query' };
      }
    } catch {
      return { error: 'Could not resolve instance context' };
    }

    const result = await queryParent(query, instanceName, instancePath, timeout_ms ?? 5000);

    if (!result) {
      logger.debug({ query, instance: instanceName }, 'Broader context query returned no results (timeout or no parent)');
      return {
        query,
        source: 'parent',
        results: null,
        note: 'Parent instance did not respond within timeout. It may not be running.',
      };
    }

    return {
      query,
      source: result.instance,
      results: result.results,
    };
  },
};
