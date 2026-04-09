/**
 * Researcher Kuzu DDL — node tables, relationship tables, and FTS indexes
 * for domain-agnostic research tracking.
 *
 * Tracks entities, events, metrics, and trends in any configurable domain
 * (AI, crypto, biotech, etc.) via LLM extraction from ingested activities.
 */

// ─── Node Tables (4) ──────────────────────────────────────────────────────────

export const RESEARCHER_NODE_TABLES = [
  `CREATE NODE TABLE IF NOT EXISTS ResearchEntity (
    entity_key STRING,
    name STRING,
    type STRING,
    domain STRING,
    url STRING,
    description STRING,
    created_at STRING,
    updated_at STRING,
    PRIMARY KEY (entity_key)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS ResearchEvent (
    event_key STRING,
    title STRING,
    date STRING,
    description STRING,
    significance STRING,
    event_type STRING,
    created_at STRING,
    updated_at STRING,
    PRIMARY KEY (event_key)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS ResearchMetric (
    metric_key STRING,
    name STRING,
    domain STRING,
    unit STRING,
    created_at STRING,
    updated_at STRING,
    PRIMARY KEY (metric_key)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS ResearchTrend (
    trend_key STRING,
    name STRING,
    first_seen STRING,
    last_seen STRING,
    domain STRING,
    created_at STRING,
    updated_at STRING,
    PRIMARY KEY (trend_key)
  )`,
];

// ─── Relationship Tables (6) ──────────────────────────────────────────────────

export const RESEARCHER_REL_TABLES = [
  `CREATE REL TABLE IF NOT EXISTS INVOLVED_IN (
    FROM ResearchEntity TO ResearchEvent,
    role STRING
  )`,

  `CREATE REL TABLE IF NOT EXISTS ENTITY_RELATED_TO (
    FROM ResearchEntity TO ResearchEntity,
    relation_type STRING,
    confidence STRING
  )`,

  `CREATE REL TABLE IF NOT EXISTS MEASURED_BY (
    FROM ResearchEntity TO ResearchMetric,
    value STRING,
    date STRING
  )`,

  `CREATE REL TABLE IF NOT EXISTS PART_OF_TREND (
    FROM ResearchEvent TO ResearchTrend
  )`,

  // Cross-schema links to base Activity node
  `CREATE REL TABLE IF NOT EXISTS ENTITY_MENTIONED_IN (
    FROM ResearchEntity TO Activity,
    extraction_date STRING
  )`,

  `CREATE REL TABLE IF NOT EXISTS EVENT_MENTIONED_IN (
    FROM ResearchEvent TO Activity,
    extraction_date STRING
  )`,
];

// ─── FTS Indexes (3) ──────────────────────────────────────────────────────────

export const RESEARCHER_FTS_INDEXES = [
  `CALL CREATE_FTS_INDEX('ResearchEntity', 'researcher_entity_idx', ['name', 'description'])`,
  `CALL CREATE_FTS_INDEX('ResearchEvent', 'researcher_event_idx', ['title', 'description'])`,
  `CALL CREATE_FTS_INDEX('ResearchTrend', 'researcher_trend_idx', ['name'])`,
];

export const RESEARCHER_FTS_DROP = [
  `CALL DROP_FTS_INDEX('ResearchEntity', 'researcher_entity_idx')`,
  `CALL DROP_FTS_INDEX('ResearchEvent', 'researcher_event_idx')`,
  `CALL DROP_FTS_INDEX('ResearchTrend', 'researcher_trend_idx')`,
];

// ─── Schema lifecycle functions ───────────────────────────────────────────────

export async function createResearcherSchema(conn: { query: (stmt: string) => Promise<unknown> }): Promise<void> {
  for (const stmt of RESEARCHER_NODE_TABLES) await conn.query(stmt);
  for (const stmt of RESEARCHER_REL_TABLES) await conn.query(stmt);
}

export async function createResearcherFtsIndexes(conn: { query: (stmt: string) => Promise<unknown> }): Promise<void> {
  for (const stmt of RESEARCHER_FTS_INDEXES) {
    try { await conn.query(stmt); } catch { /* table may be empty or index already exists */ }
  }
}

export async function rebuildResearcherFtsIndexes(conn: { query: (stmt: string) => Promise<unknown> }): Promise<void> {
  for (const stmt of RESEARCHER_FTS_DROP) {
    try { await conn.query(stmt); } catch { /* index may not exist on first run */ }
  }
  await createResearcherFtsIndexes(conn);
}
