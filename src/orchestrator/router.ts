import type { NormalizedMessage } from '../shared/types.js';
import type { ClassificationBatch } from './types.js';

/** Grouped routing results: instance name → messages to deliver */
export interface RoutingPlan {
  /** Messages grouped by target instance */
  targeted: Map<string, NormalizedMessage[]>;
  /** Messages with no targets — stay in global */
  global: NormalizedMessage[];
}

/**
 * Convert classification results into a delivery plan.
 * Handles multi-target fanout: a message targeting ["aballos", "alfred"]
 * appears in both instance buckets.
 */
export function buildRoutingPlan(batch: ClassificationBatch): RoutingPlan {
  const targeted = new Map<string, NormalizedMessage[]>();
  const global: NormalizedMessage[] = [];

  for (const { message, decision } of batch.results) {
    if (decision.targets.length === 0) {
      global.push(message);
      continue;
    }

    // Fanout: same message goes to all targets
    for (const target of decision.targets) {
      const existing = targeted.get(target) ?? [];
      existing.push(message);
      targeted.set(target, existing);
    }
  }

  // Errors always go to global
  for (const { message } of batch.errors) {
    global.push(message);
  }

  return { targeted, global };
}
