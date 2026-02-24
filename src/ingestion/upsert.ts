import { getSession } from '../shared/neo4j.js';
import type { NormalizedMessage } from '../shared/types.js';
import { logger } from '../shared/logger.js';

const UPSERT_CYPHER = `
UNWIND $batch AS item

// Person
MERGE (p:Person {person_key: item.person_key})
ON CREATE SET p.display_name = item.display_name,
              p.source = item.person_source,
              p.source_id = item.person_source_id
ON MATCH SET  p.display_name = item.display_name

// Container
MERGE (c:Container {source: item.container_source, container_id: item.container_id})
ON CREATE SET c.name = item.container_name, c.kind = item.container_kind

// SourceAccount
MERGE (sa:SourceAccount {source: item.account_source, account_id: item.account_id})
ON CREATE SET sa.linked_person_key = item.person_key
MERGE (sa)-[:IDENTIFIES]->(p)

// Activity
MERGE (a:Activity {source: item.activity_source, source_id: item.activity_source_id})
ON CREATE SET a.timestamp = item.timestamp,
              a.kind = item.kind,
              a.snippet = item.snippet,
              a.url = item.url,
              a.thread_ts = item.thread_ts

// Relationships
MERGE (sa)-[:OWNS]->(a)
MERGE (a)-[:FROM]->(p)
MERGE (a)-[:IN]->(c)

// Topics
WITH a, item
UNWIND item.topics AS topicName
MERGE (t:Topic {name: topicName})
MERGE (a)-[:MENTIONS]->(t)
`;

/**
 * Flatten a NormalizedMessage into a plain object for Cypher parameter passing.
 */
function toParams(msg: NormalizedMessage): Record<string, unknown> {
  return {
    person_key: msg.person.person_key,
    display_name: msg.person.display_name,
    person_source: msg.person.source,
    person_source_id: msg.person.source_id,
    container_source: msg.container.source,
    container_id: msg.container.container_id,
    container_name: msg.container.name,
    container_kind: msg.container.kind,
    account_source: msg.account.source,
    account_id: msg.account.account_id,
    activity_source: msg.activity.source,
    activity_source_id: msg.activity.source_id,
    timestamp: msg.activity.timestamp,
    kind: msg.activity.kind,
    snippet: msg.activity.snippet,
    url: msg.activity.url ?? null,
    thread_ts: msg.activity.thread_ts ?? null,
    topics: msg.topics.map((t) => t.name),
  };
}

/**
 * Upsert a batch of normalized messages into Neo4j.
 * Uses MERGE for full idempotency — safe to re-run.
 */
export async function upsertBatch(messages: NormalizedMessage[]): Promise<void> {
  if (messages.length === 0) return;

  const batch = messages.map(toParams);
  const session = getSession();
  try {
    await session.executeWrite(async (tx) => {
      await tx.run(UPSERT_CYPHER, { batch });
    });
    logger.info({ count: messages.length }, 'Upserted batch');
  } finally {
    await session.close();
  }
}
