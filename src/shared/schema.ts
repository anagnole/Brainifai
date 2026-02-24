import { getSession } from './neo4j.js';
import { logger } from './logger.js';

const CONSTRAINTS = [
  // Person: unique by person_key e.g. "slack:U12345"
  `CREATE CONSTRAINT person_key IF NOT EXISTS
   FOR (p:Person) REQUIRE p.person_key IS UNIQUE`,

  // Activity: unique by compound (source, source_id)
  `CREATE CONSTRAINT activity_source IF NOT EXISTS
   FOR (a:Activity) REQUIRE (a.source, a.source_id) IS UNIQUE`,

  // Topic: unique by normalized name
  `CREATE CONSTRAINT topic_name IF NOT EXISTS
   FOR (t:Topic) REQUIRE t.name IS UNIQUE`,

  // Container: unique by (source, container_id)
  `CREATE CONSTRAINT container_source IF NOT EXISTS
   FOR (c:Container) REQUIRE (c.source, c.container_id) IS UNIQUE`,

  // SourceAccount: unique by (source, account_id)
  `CREATE CONSTRAINT source_account IF NOT EXISTS
   FOR (sa:SourceAccount) REQUIRE (sa.source, sa.account_id) IS UNIQUE`,

  // Cursor: one per (source, container_id)
  `CREATE CONSTRAINT cursor_key IF NOT EXISTS
   FOR (cur:Cursor) REQUIRE (cur.source, cur.container_id) IS UNIQUE`,
];

const INDEXES = [
  // Activity timestamp for time-windowed queries
  `CREATE INDEX activity_ts IF NOT EXISTS
   FOR (a:Activity) ON (a.timestamp)`,

  // Fulltext index for entity search
  `CREATE FULLTEXT INDEX entity_search IF NOT EXISTS
   FOR (n:Person|Topic|Container) ON EACH [n.display_name, n.name]`,
];

export async function seedSchema(): Promise<void> {
  const session = getSession();
  try {
    for (const stmt of [...CONSTRAINTS, ...INDEXES]) {
      await session.run(stmt);
    }
    logger.info('Schema constraints and indexes created');
  } finally {
    await session.close();
  }
}
