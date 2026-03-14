import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import { truncateEvidence } from '../../mcp/safety.js';
import { DEFAULT_WINDOW_DAYS } from '../../shared/constants.js';

export const decisionLogFn: ContextFunction = {
  name: 'get_decision_log',
  description: 'Get a log of recent technical decisions, insights, and bug fixes from the knowledge graph',
  schema: {
    window_days: z.number().int().min(1).max(365).default(30)
      .describe('How many days back to look'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('Maximum entries to return'),
  },
  async execute(input, store) {
    const { window_days, limit } = input as { window_days?: number; limit?: number };

    const windowDays = window_days ?? DEFAULT_WINDOW_DAYS;
    const maxItems = Math.min(limit ?? 20, 50);
    const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    // Query decision-type activities
    const items = await store.getRecentActivity({
      kinds: ['decision', 'insight', 'bug_fix', 'session_summary'],
      since: windowStart,
      limit: maxItems,
    });

    const entries = truncateEvidence(
      items.map((i) => ({
        timestamp: i.timestamp,
        kind: i.kind,
        snippet: i.snippet,
        actor: i.actor,
        channel: i.channel,
        url: i.url,
      })),
      maxItems,
    );

    return { window_days: windowDays, decisions: entries, total: entries.length };
  },
};
