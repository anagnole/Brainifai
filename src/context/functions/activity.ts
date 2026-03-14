import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import { truncateEvidence } from '../../mcp/safety.js';
import { DEFAULT_WINDOW_DAYS } from '../../shared/constants.js';

export const recentActivityFn: ContextFunction = {
  name: 'get_recent_activity',
  description: 'Fetch recent activities with optional filters by person, topic, or channel',
  schema: {
    person_key: z.string().optional()
      .describe('Filter by person (e.g. "slack:U12345")'),
    topic: z.string().optional()
      .describe('Filter by topic name'),
    container_id: z.string().optional()
      .describe('Filter by channel/container ID'),
    window_days: z.number().int().min(1).max(365).default(7)
      .describe('How many days back to look'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('Maximum results to return'),
  },
  async execute(input, store) {
    const { person_key, topic, container_id, window_days, limit } = input as {
      person_key?: string; topic?: string; container_id?: string;
      window_days?: number; limit?: number;
    };

    const windowDays = window_days ?? DEFAULT_WINDOW_DAYS;
    const maxItems = Math.min(limit ?? 20, 50);
    const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    // Strip source prefix from containerId if present (e.g. "clickup:123" → "123")
    let cid = container_id;
    if (cid) {
      const colonIdx = cid.indexOf(':');
      if (colonIdx > 0) cid = cid.slice(colonIdx + 1);
    }

    const items = await store.getRecentActivity({
      personKey: person_key,
      topic,
      containerId: cid,
      since: windowStart,
      limit: maxItems,
    });

    const mapped = items.map((i) => ({
      timestamp: i.timestamp,
      person: i.actor,
      channel: i.channel,
      kind: i.kind,
      snippet: i.snippet,
      url: i.url,
    }));

    return truncateEvidence(mapped, maxItems);
  },
};
