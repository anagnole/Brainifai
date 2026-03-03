/** Neo4j DDL — constraints, indexes, and fulltext index for entity search. */

export const NEO4J_CONSTRAINTS = [
  `CREATE CONSTRAINT person_key IF NOT EXISTS
   FOR (p:Person) REQUIRE p.person_key IS UNIQUE`,

  `CREATE CONSTRAINT activity_source IF NOT EXISTS
   FOR (a:Activity) REQUIRE (a.source, a.source_id) IS UNIQUE`,

  `CREATE CONSTRAINT topic_name IF NOT EXISTS
   FOR (t:Topic) REQUIRE t.name IS UNIQUE`,

  `CREATE CONSTRAINT container_source IF NOT EXISTS
   FOR (c:Container) REQUIRE (c.source, c.container_id) IS UNIQUE`,

  `CREATE CONSTRAINT source_account IF NOT EXISTS
   FOR (sa:SourceAccount) REQUIRE (sa.source, sa.account_id) IS UNIQUE`,

  `CREATE CONSTRAINT cursor_key IF NOT EXISTS
   FOR (cur:Cursor) REQUIRE (cur.source, cur.container_id) IS UNIQUE`,
];

export const NEO4J_INDEXES = [
  `CREATE INDEX activity_ts IF NOT EXISTS
   FOR (a:Activity) ON (a.timestamp)`,

  `CREATE FULLTEXT INDEX entity_search IF NOT EXISTS
   FOR (n:Person|Topic|Container) ON EACH [n.display_name, n.name]`,
];
