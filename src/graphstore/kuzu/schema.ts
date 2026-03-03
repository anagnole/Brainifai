/** Kuzu DDL — node tables, rel tables, and FTS indexes. */

export const KUZU_NODE_TABLES = [
  `CREATE NODE TABLE IF NOT EXISTS Person (
    person_key STRING,
    display_name STRING,
    source STRING,
    source_id STRING,
    avatar_url STRING,
    PRIMARY KEY (person_key)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Activity (
    source STRING,
    source_id STRING,
    timestamp STRING,
    kind STRING,
    snippet STRING,
    url STRING,
    thread_ts STRING,
    PRIMARY KEY (source_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Topic (
    name STRING,
    PRIMARY KEY (name)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Container (
    source STRING,
    container_id STRING,
    name STRING,
    kind STRING,
    url STRING,
    PRIMARY KEY (container_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS SourceAccount (
    source STRING,
    account_id STRING,
    linked_person_key STRING,
    PRIMARY KEY (account_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Cursor (
    source STRING,
    container_id STRING,
    latest_ts STRING,
    updated_at STRING,
    PRIMARY KEY (container_id)
  )`,
];

export const KUZU_REL_TABLES = [
  `CREATE REL TABLE IF NOT EXISTS IDENTIFIES (FROM SourceAccount TO Person)`,
  `CREATE REL TABLE IF NOT EXISTS OWNS (FROM SourceAccount TO Activity)`,
  `CREATE REL TABLE IF NOT EXISTS FROM_PERSON (FROM Activity TO Person)`,
  `CREATE REL TABLE IF NOT EXISTS IN_CONTAINER (FROM Activity TO Container)`,
  `CREATE REL TABLE IF NOT EXISTS MENTIONS (FROM Activity TO Topic)`,
];

/** Map from our logical rel type to Kuzu's table name (since FROM/IN are reserved). */
export const REL_TYPE_MAP: Record<string, string> = {
  IDENTIFIES: 'IDENTIFIES',
  OWNS: 'OWNS',
  FROM: 'FROM_PERSON',
  IN: 'IN_CONTAINER',
  MENTIONS: 'MENTIONS',
};

/**
 * FTS index creation statements.
 * Kuzu FTS indexes are per-table and immutable — they must be rebuilt after data changes.
 * We create separate indexes for Person, Topic, and Container.
 */
export const KUZU_FTS_INDEXES = [
  `CALL CREATE_FTS_INDEX('Person', 'person_fts', ['display_name'])`,
  `CALL CREATE_FTS_INDEX('Topic', 'topic_fts', ['name'])`,
  `CALL CREATE_FTS_INDEX('Container', 'container_fts', ['name'])`,
];

export const KUZU_FTS_DROP = [
  `CALL DROP_FTS_INDEX('Person', 'person_fts')`,
  `CALL DROP_FTS_INDEX('Topic', 'topic_fts')`,
  `CALL DROP_FTS_INDEX('Container', 'container_fts')`,
];
