import neo4j from 'neo4j-driver';
import { getSession } from '../../shared/neo4j.js';
import { withTimeout, truncateEvidence } from '../safety.js';
import { DEFAULT_WINDOW_DAYS } from '../../shared/constants.js';

export interface ActivityItem {
  timestamp: string;
  person: string;
  channel: string;
  kind: string;
  snippet: string;
  url?: string;
}

/**
 * Fetch recent activities with optional filters.
 */
export async function getRecentActivity(opts: {
  personKey?: string;
  topic?: string;
  containerId?: string;
  windowDays?: number;
  limit?: number;
}): Promise<ActivityItem[]> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const limit = Math.min(opts.limit ?? 20, 50);
  const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

  const session = getSession();
  try {
    // Build dynamic WHERE clauses
    const filters: string[] = [`a.timestamp >= $windowStart`];
    const params: Record<string, unknown> = { windowStart, limit: neo4j.int(limit) };

    if (opts.personKey) {
      filters.push(`p.person_key = $personKey`);
      params.personKey = opts.personKey;
    }
    if (opts.topic) {
      filters.push(`EXISTS { (a)-[:MENTIONS]->(:Topic {name: $topic}) }`);
      params.topic = opts.topic.toLowerCase();
    }
    if (opts.containerId) {
      filters.push(`c.container_id = $containerId`);
      params.containerId = opts.containerId;
    }

    const cypher = `
      MATCH (a:Activity)-[:FROM]->(p:Person),
            (a)-[:IN]->(c:Container)
      WHERE ${filters.join(' AND ')}
      RETURN a.timestamp AS timestamp,
             coalesce(p.display_name, p.person_key) AS person,
             c.name AS channel,
             a.kind AS kind,
             a.snippet AS snippet,
             a.url AS url
      ORDER BY a.timestamp DESC
      LIMIT $limit
    `;

    const result = await withTimeout(session.run(cypher, params));

    const items = result.records.map((r) => ({
      timestamp: r.get('timestamp') as string,
      person: r.get('person') as string,
      channel: r.get('channel') as string,
      kind: r.get('kind') as string,
      snippet: r.get('snippet') as string,
      url: r.get('url') as string | undefined,
    }));

    return truncateEvidence(items, limit);
  } finally {
    await session.close();
  }
}
