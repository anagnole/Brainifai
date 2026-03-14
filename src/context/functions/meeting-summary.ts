import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import { truncateEvidence } from '../../mcp/safety.js';
import { DEFAULT_WINDOW_DAYS } from '../../shared/constants.js';

export const meetingSummaryFn: ContextFunction = {
  name: 'get_meeting_summary',
  description: 'Get a summary of recent calendar events and meetings',
  schema: {
    window_days: z.number().int().min(1).max(365).default(14)
      .describe('How many days back to look'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('Maximum meetings to return'),
  },
  async execute(input, store) {
    const { window_days, limit } = input as { window_days?: number; limit?: number };

    const windowDays = window_days ?? DEFAULT_WINDOW_DAYS;
    const maxItems = Math.min(limit ?? 20, 50);
    const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    // Query calendar-sourced activities
    const items = await store.getRecentActivity({
      kinds: ['calendar_event', 'meeting'],
      since: windowStart,
      limit: maxItems,
    });

    // If no calendar-specific kinds, fall back to apple-calendar source
    const results = items.length > 0 ? items : await store.getRecentActivity({
      since: windowStart,
      limit: maxItems,
    }).then((all) => all.filter((i) => i.source === 'apple-calendar'));

    const meetings = truncateEvidence(
      results.map((i) => ({
        timestamp: i.timestamp,
        kind: i.kind,
        snippet: i.snippet,
        actor: i.actor,
        channel: i.channel,
        url: i.url,
      })),
      maxItems,
    );

    return { window_days: windowDays, meetings, total: meetings.length };
  },
};
