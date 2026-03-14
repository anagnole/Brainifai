// ─── Resolve active context functions for an instance ────────────────────────

import type { InstanceConfig } from '../instance/types.js';
import { getTemplate } from '../instance/templates.js';

/** The 5 base function names available to all instances by default */
export const BASE_FUNCTION_NAMES = [
  'get_context_packet',
  'search_entities',
  'get_entity_summary',
  'get_recent_activity',
  'ingest_memory',
];

/**
 * Resolve which context functions should be active for an instance.
 * Priority: explicit config > template defaults > base defaults.
 */
export function resolveContextFunctions(config: InstanceConfig): string[] {
  // If explicitly set in config, use that (user has overridden)
  if (config.contextFunctions && config.contextFunctions.length > 0) {
    return config.contextFunctions;
  }
  // Otherwise fall back to template defaults
  const template = getTemplate(config.type);
  return template?.contextFunctions ?? BASE_FUNCTION_NAMES;
}
