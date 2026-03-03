import { getGraphStore } from '../../shared/graphstore.js';

export interface EntitySummary {
  id: string;
  type: string;
  name: string;
  activityCount: number;
  recentActivity?: string;
  topConnections: Array<{ name: string; type: string; weight: number }>;
}

/**
 * Get a summary of an entity: its type, activity count, and top connections.
 */
export async function getEntitySummary(entityId: string): Promise<EntitySummary | null> {
  const store = await getGraphStore();
  return store.getEntitySummary(entityId);
}
