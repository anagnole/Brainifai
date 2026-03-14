import { z } from 'zod';
import type { ContextFunction } from '../types.js';

export const entitySummaryFn: ContextFunction = {
  name: 'get_entity_summary',
  description: 'Get a summary of an entity including activity count and top connections',
  schema: {
    entity_id: z.string().describe(
      'Entity identifier: person_key (e.g. "slack:U12345"), topic name, or "source:container_id"',
    ),
  },
  async execute(input, store) {
    const { entity_id } = input as { entity_id: string };
    const summary = await store.getEntitySummary(entity_id);
    if (!summary) return { error: 'Entity not found' };

    // Format as readable markdown for the LLM
    const lines = [
      `## ${summary.name} (${summary.type})`,
      `**Activities:** ${summary.activityCount}`,
    ];
    if (summary.recentActivity) {
      lines.push(`**Most recent:** ${summary.recentActivity}`);
    }
    if (summary.topConnections.length > 0) {
      lines.push('', '**Top connections:**');
      for (const conn of summary.topConnections) {
        lines.push(`- ${conn.name} (${conn.type}) — ${conn.weight} shared activities`);
      }
    }
    return { formatted: lines.join('\n'), raw: summary };
  },
};
