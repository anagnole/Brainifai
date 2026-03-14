/** Kuzu DDL — node tables, rel tables, and FTS indexes. */

/**
 * Migration: add new columns to existing tables.
 * Kuzu's `CREATE ... IF NOT EXISTS` won't alter existing tables,
 * so we use ALTER TABLE to add columns that may be missing.
 * Each statement is safe to re-run — errors are silently ignored
 * (column already exists, or table doesn't exist yet).
 */
export const KUZU_MIGRATIONS = [
  // Node table columns
  `ALTER TABLE Person ADD created_at STRING`,
  `ALTER TABLE Person ADD updated_at STRING`,
  `ALTER TABLE Activity ADD parent_source_id STRING`,
  `ALTER TABLE Activity ADD created_at STRING`,
  `ALTER TABLE Activity ADD updated_at STRING`,
  `ALTER TABLE Activity ADD valid_from STRING`,
  `ALTER TABLE Topic ADD created_at STRING`,
  `ALTER TABLE Topic ADD updated_at STRING`,
  `ALTER TABLE Container ADD created_at STRING`,
  `ALTER TABLE Container ADD updated_at STRING`,
  `ALTER TABLE SourceAccount ADD created_at STRING`,
  `ALTER TABLE SourceAccount ADD updated_at STRING`,
  // Rel table columns
  `ALTER TABLE IDENTIFIES ADD first_seen STRING`,
  `ALTER TABLE OWNS ADD timestamp STRING`,
  `ALTER TABLE FROM_PERSON ADD timestamp STRING`,
  `ALTER TABLE IN_CONTAINER ADD timestamp STRING`,
  `ALTER TABLE MENTIONS ADD timestamp STRING`,
];

export const KUZU_NODE_TABLES = [
  `CREATE NODE TABLE IF NOT EXISTS Person (
    person_key STRING,
    display_name STRING,
    source STRING,
    source_id STRING,
    avatar_url STRING,
    created_at STRING,
    updated_at STRING,
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
    parent_source_id STRING,
    created_at STRING,
    updated_at STRING,
    valid_from STRING,
    PRIMARY KEY (source_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Topic (
    name STRING,
    created_at STRING,
    updated_at STRING,
    PRIMARY KEY (name)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Container (
    source STRING,
    container_id STRING,
    name STRING,
    kind STRING,
    url STRING,
    created_at STRING,
    updated_at STRING,
    PRIMARY KEY (container_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS SourceAccount (
    source STRING,
    account_id STRING,
    linked_person_key STRING,
    created_at STRING,
    updated_at STRING,
    PRIMARY KEY (account_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Cursor (
    source STRING,
    container_id STRING,
    latest_ts STRING,
    updated_at STRING,
    PRIMARY KEY (container_id)
  )`,

  // Instance registry (global DB only — tracks child instances)
  `CREATE NODE TABLE IF NOT EXISTS Instance (
    name STRING,
    type STRING,
    description STRING,
    path STRING,
    parent STRING,
    status STRING DEFAULT 'active',
    created_at STRING,
    updated_at STRING,
    PRIMARY KEY (name)
  )`,
];

export const KUZU_REL_TABLES = [
  `CREATE REL TABLE IF NOT EXISTS IDENTIFIES (FROM SourceAccount TO Person, first_seen STRING)`,
  `CREATE REL TABLE IF NOT EXISTS OWNS (FROM SourceAccount TO Activity, timestamp STRING)`,
  `CREATE REL TABLE IF NOT EXISTS FROM_PERSON (FROM Activity TO Person, timestamp STRING)`,
  `CREATE REL TABLE IF NOT EXISTS IN_CONTAINER (FROM Activity TO Container, timestamp STRING)`,
  `CREATE REL TABLE IF NOT EXISTS MENTIONS (FROM Activity TO Topic, timestamp STRING)`,
  `CREATE REL TABLE IF NOT EXISTS REPLIES_TO (FROM Activity TO Activity, timestamp STRING)`,
  `CREATE REL TABLE IF NOT EXISTS MENTIONS_PERSON (FROM Activity TO Person, timestamp STRING)`,

  // Instance hierarchy (global DB only)
  `CREATE REL TABLE IF NOT EXISTS PARENT_OF (FROM Instance TO Instance)`,
];

/** Map from our logical rel type to Kuzu's table name (since FROM/IN are reserved). */
export const REL_TYPE_MAP: Record<string, string> = {
  IDENTIFIES: 'IDENTIFIES',
  OWNS: 'OWNS',
  FROM: 'FROM_PERSON',
  IN: 'IN_CONTAINER',
  MENTIONS: 'MENTIONS',
  REPLIES_TO: 'REPLIES_TO',
  MENTIONS_PERSON: 'MENTIONS_PERSON',
  PARENT_OF: 'PARENT_OF',
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
  `CALL CREATE_FTS_INDEX('Activity', 'activity_fts', ['snippet', 'kind'])`,
  `CALL CREATE_FTS_INDEX('Instance', 'instance_fts', ['name', 'description'])`,
];

export const KUZU_FTS_DROP = [
  `CALL DROP_FTS_INDEX('Person', 'person_fts')`,
  `CALL DROP_FTS_INDEX('Topic', 'topic_fts')`,
  `CALL DROP_FTS_INDEX('Container', 'container_fts')`,
  `CALL DROP_FTS_INDEX('Activity', 'activity_fts')`,
  `CALL DROP_FTS_INDEX('Instance', 'instance_fts')`,
];
