import { getGraphStore } from '../../shared/graphstore.js';

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
  const store = await getGraphStore();
  return store.search({ query, types, limit });
}
