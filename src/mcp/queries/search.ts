import neo4j from 'neo4j-driver';
import { getSession } from '../../shared/neo4j.js';
import { withTimeout } from '../safety.js';

export interface SearchResult {
  id: string;
  type: string;
  name: string;
  score: number;
}

/**
 * Fulltext search across Person, Topic, and Container nodes.
 */
export async function searchEntities(
  query: string,
  types?: string[],
  limit: number = 10,
): Promise<SearchResult[]> {
  const session = getSession();
  try {
    // Escape lucene special chars and add fuzzy matching
    const safeQuery = query.replace(/[+\-&|!(){}[\]^"~*?:\\\/]/g, '\\$&');
    const fuzzyQuery = safeQuery.split(/\s+/).map((w) => `${w}~`).join(' ');

    const typeFilter = types && types.length > 0
      ? `AND any(label IN labels(node) WHERE label IN $types)`
      : '';

    const result = await withTimeout(
      session.run(
        `CALL db.index.fulltext.queryNodes('entity_search', $query)
         YIELD node, score
         WHERE score > 0.3 ${typeFilter}
         RETURN
           CASE
             WHEN node:Person THEN node.person_key
             WHEN node:Container THEN node.source + ':' + node.container_id
             ELSE node.name
           END AS id,
           head(labels(node)) AS type,
           coalesce(node.display_name, node.name) AS name,
           score
         ORDER BY score DESC
         LIMIT $limit`,
        { query: fuzzyQuery, types: types ?? [], limit: neo4j.int(limit) },
      ),
    );

    return result.records.map((r) => ({
      id: r.get('id') as string,
      type: r.get('type') as string,
      name: r.get('name') as string,
      score: r.get('score') as number,
    }));
  } finally {
    await session.close();
  }
}
