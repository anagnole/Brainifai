import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import { truncateEvidence } from '../../mcp/safety.js';
import { DEFAULT_WINDOW_DAYS } from '../../shared/constants.js';

export const prSummaryFn: ContextFunction = {
  name: 'get_pr_summary',
  description: 'Get a summary of recent pull requests — titles, status, authors, and activity grouped by repository',
  schema: {
    window_days: z.number().int().min(1).max(365).default(14)
      .describe('How many days back to look'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('Maximum PRs to return'),
  },
  async execute(input, store) {
    const { window_days, limit } = input as { window_days?: number; limit?: number };

    const windowDays = window_days ?? DEFAULT_WINDOW_DAYS;
    const maxItems = Math.min(limit ?? 20, 50);
    const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

    // Query activities from GitHub source with PR-related kinds
    const items = await store.getRecentActivity({
      kinds: ['pull_request', 'pr_review', 'pr_comment'],
      since: windowStart,
      limit: maxItems,
    });

    // If no PR-specific kinds, fall back to all github-source activities
    const results = items.length > 0 ? items : await store.getRecentActivity({
      since: windowStart,
      limit: maxItems,
    }).then((all) => all.filter((i) => i.source === 'github'));

    // Group by channel (repo)
    const byRepo = new Map<string, typeof results>();
    for (const item of results) {
      const group = byRepo.get(item.channel) ?? [];
      group.push(item);
      byRepo.set(item.channel, group);
    }

    const grouped = Object.fromEntries(
      [...byRepo.entries()].map(([repo, items]) => [
        repo,
        truncateEvidence(
          items.map((i) => ({
            timestamp: i.timestamp,
            kind: i.kind,
            snippet: i.snippet,
            actor: i.actor,
            url: i.url,
          })),
          maxItems,
        ),
      ]),
    );

    return { window_days: windowDays, repos: grouped, total: results.length };
  },
};
