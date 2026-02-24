import { getSession } from '../../shared/neo4j.js';
import { withTimeout } from '../safety.js';

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
 * `entityId` can be a person_key, topic name, or source:container_id.
 */
export async function getEntitySummary(entityId: string): Promise<EntitySummary | null> {
  const session = getSession();
  try {
    const result = await withTimeout(
      session.run(
        `// Try to find the entity by any key
         OPTIONAL MATCH (p:Person {person_key: $id})
         OPTIONAL MATCH (t:Topic {name: $id})
         OPTIONAL MATCH (c:Container)
           WHERE c.source + ':' + c.container_id = $id
         WITH coalesce(p, t, c) AS entity
         WHERE entity IS NOT NULL

         // Count activities
         OPTIONAL MATCH (entity)<-[*1..2]-(a:Activity)
         WITH entity, count(DISTINCT a) AS activityCount,
              max(a.timestamp) AS latestTs

         // Top connected entities (1 hop through activities)
         OPTIONAL MATCH (entity)<-[*1..2]-(a2:Activity)-[*1..2]->(other)
         WHERE other <> entity AND (other:Person OR other:Topic OR other:Container)
         WITH entity, activityCount, latestTs, other,
              head(labels(other)) AS otherType,
              coalesce(other.display_name, other.name) AS otherName,
              count(*) AS weight
         ORDER BY weight DESC
         WITH entity, activityCount, latestTs,
              collect({name: otherName, type: otherType, weight: weight})[..10] AS connections

         RETURN
           CASE
             WHEN entity:Person THEN entity.person_key
             WHEN entity:Container THEN entity.source + ':' + entity.container_id
             ELSE entity.name
           END AS id,
           head(labels(entity)) AS type,
           coalesce(entity.display_name, entity.name) AS name,
           activityCount,
           latestTs AS recentActivity,
           connections AS topConnections`,
        { id: entityId },
      ),
    );

    const record = result.records[0];
    if (!record) return null;

    return {
      id: record.get('id') as string,
      type: record.get('type') as string,
      name: record.get('name') as string,
      activityCount: (record.get('activityCount') as any)?.toNumber?.() ?? record.get('activityCount') as number,
      recentActivity: record.get('recentActivity') as string | undefined,
      topConnections: record.get('topConnections') as any[],
    };
  } finally {
    await session.close();
  }
}
