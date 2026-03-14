import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import { truncateEvidence } from '../../mcp/safety.js';
import { DEFAULT_WINDOW_DAYS } from '../../shared/constants.js';

export const peopleContextFn: ContextFunction = {
  name: 'get_people_context',
  description: 'Get aggregated context about a person — their activities across channels, top topics, and connections',
  schema: {
    name: z.string().describe('Person name or key to look up'),
    window_days: z.number().int().min(1).max(365).default(30)
      .describe('How many days back to look'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('Maximum activity items to return'),
  },
  async execute(input, store) {
    const { name, window_days, limit } = input as {
      name: string; window_days?: number; limit?: number;
    };

    const windowDays = window_days ?? DEFAULT_WINDOW_DAYS;
    const maxItems = Math.min(limit ?? 20, 50);
    const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    // Search for the person entity
    const searchResults = await store.search({ query: name, types: ['Person'], limit: 3 });
    if (searchResults.length === 0) {
      return { error: `No person found matching "${name}"` };
    }

    const person = searchResults[0];

    // Get entity summary for connections
    const summary = await store.getEntitySummary(person.id);

    // Get their recent activities
    const activities = await store.getRecentActivity({
      personKey: person.id,
      since: windowStart,
      limit: maxItems,
    });

    const mappedActivities = truncateEvidence(
      activities.map((i) => ({
        timestamp: i.timestamp,
        kind: i.kind,
        snippet: i.snippet,
        channel: i.channel,
        url: i.url,
      })),
      maxItems,
    );

    // Group activities by channel
    const channelCounts = new Map<string, number>();
    for (const a of activities) {
      channelCounts.set(a.channel, (channelCounts.get(a.channel) ?? 0) + 1);
    }

    return {
      person: { id: person.id, name: person.name, score: person.score },
      activityCount: summary?.activityCount ?? activities.length,
      topConnections: summary?.topConnections ?? [],
      channelDistribution: Object.fromEntries(channelCounts),
      recentActivities: mappedActivities,
    };
  },
};
