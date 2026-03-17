/**
 * EHR Kuzu DDL — node tables, relationship tables, and FTS indexes
 * for clinical Electronic Health Record data.
 *
 * Schema aligns with ThesisBrainifai/src/parser/types.ts (8 entity types).
 * Field names use snake_case for Cypher readability; the ingestion script
 * maps from camelCase (JSON) to snake_case (Kuzu).
 */

// ─── Node Tables (8) ──────────────────────────────────────────────────────────

export const EHR_NODE_TABLES = [
  `CREATE NODE TABLE IF NOT EXISTS Patient (
    patient_id STRING,
    first_name STRING,
    last_name STRING,
    birth_date STRING,
    death_date STRING,
    gender STRING,
    race STRING,
    ethnicity STRING,
    marital_status STRING,
    city STRING,
    state STRING,
    zip STRING,
    PRIMARY KEY (patient_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Encounter (
    encounter_id STRING,
    patient_id STRING,
    provider_id STRING,
    organization_id STRING,
    encounter_class STRING,
    code STRING,
    description STRING,
    start_date STRING,
    stop_date STRING,
    reason_code STRING,
    reason_description STRING,
    PRIMARY KEY (encounter_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Condition (
    condition_id STRING,
    patient_id STRING,
    encounter_id STRING,
    code STRING,
    system STRING,
    description STRING,
    start_date STRING,
    stop_date STRING,
    PRIMARY KEY (condition_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Medication (
    medication_id STRING,
    patient_id STRING,
    encounter_id STRING,
    code STRING,
    description STRING,
    start_date STRING,
    stop_date STRING,
    reason_code STRING,
    reason_description STRING,
    PRIMARY KEY (medication_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Observation (
    observation_id STRING,
    patient_id STRING,
    encounter_id STRING,
    category STRING,
    code STRING,
    description STRING,
    value STRING,
    units STRING,
    type STRING,
    date STRING,
    PRIMARY KEY (observation_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Procedure (
    procedure_id STRING,
    patient_id STRING,
    encounter_id STRING,
    code STRING,
    system STRING,
    description STRING,
    start_date STRING,
    stop_date STRING,
    reason_code STRING,
    reason_description STRING,
    PRIMARY KEY (procedure_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Provider (
    provider_id STRING,
    organization_id STRING,
    name STRING,
    gender STRING,
    specialty STRING,
    PRIMARY KEY (provider_id)
  )`,

  `CREATE NODE TABLE IF NOT EXISTS Organization (
    organization_id STRING,
    name STRING,
    city STRING,
    state STRING,
    zip STRING,
    phone STRING,
    PRIMARY KEY (organization_id)
  )`,
];

// ─── Relationship Tables (14) ─────────────────────────────────────────────────

export const EHR_REL_TABLES = [
  // Patient → clinical entities
  `CREATE REL TABLE IF NOT EXISTS HAS_ENCOUNTER (FROM Patient TO Encounter)`,
  `CREATE REL TABLE IF NOT EXISTS HAS_CONDITION (FROM Patient TO Condition)`,
  `CREATE REL TABLE IF NOT EXISTS HAS_MEDICATION (FROM Patient TO Medication)`,
  `CREATE REL TABLE IF NOT EXISTS HAS_OBSERVATION (FROM Patient TO Observation)`,
  `CREATE REL TABLE IF NOT EXISTS HAS_PROCEDURE (FROM Patient TO Procedure)`,

  // Encounter → clinical entities (what happened at this visit)
  `CREATE REL TABLE IF NOT EXISTS ENCOUNTER_DIAGNOSIS (FROM Encounter TO Condition)`,
  `CREATE REL TABLE IF NOT EXISTS ENCOUNTER_MEDICATION (FROM Encounter TO Medication)`,
  `CREATE REL TABLE IF NOT EXISTS ENCOUNTER_OBSERVATION (FROM Encounter TO Observation)`,
  `CREATE REL TABLE IF NOT EXISTS ENCOUNTER_PROCEDURE (FROM Encounter TO Procedure)`,

  // Provider relationships
  `CREATE REL TABLE IF NOT EXISTS TREATED_BY (FROM Encounter TO Provider)`,
  `CREATE REL TABLE IF NOT EXISTS PRESCRIBED_BY (FROM Medication TO Provider)`,
  `CREATE REL TABLE IF NOT EXISTS ORDERED_BY (FROM Observation TO Provider)`,

  // Organization relationships
  `CREATE REL TABLE IF NOT EXISTS AFFILIATED_WITH (FROM Provider TO Organization)`,
  `CREATE REL TABLE IF NOT EXISTS AT_ORGANIZATION (FROM Encounter TO Organization)`,
];

// ─── FTS Indexes (7) ──────────────────────────────────────────────────────────

export const EHR_FTS_INDEXES = [
  `CALL CREATE_FTS_INDEX('Patient', 'patient_fts', ['first_name', 'last_name', 'city'])`,
  `CALL CREATE_FTS_INDEX('Condition', 'condition_fts', ['description', 'code'])`,
  `CALL CREATE_FTS_INDEX('Medication', 'medication_fts', ['description', 'code'])`,
  `CALL CREATE_FTS_INDEX('Observation', 'observation_fts', ['description', 'code'])`,
  `CALL CREATE_FTS_INDEX('Procedure', 'procedure_fts', ['description', 'code'])`,
  `CALL CREATE_FTS_INDEX('Provider', 'provider_fts', ['name', 'specialty'])`,
  `CALL CREATE_FTS_INDEX('Organization', 'organization_fts', ['name', 'city'])`,
];

export const EHR_FTS_DROP = [
  `CALL DROP_FTS_INDEX('Patient', 'patient_fts')`,
  `CALL DROP_FTS_INDEX('Condition', 'condition_fts')`,
  `CALL DROP_FTS_INDEX('Medication', 'medication_fts')`,
  `CALL DROP_FTS_INDEX('Observation', 'observation_fts')`,
  `CALL DROP_FTS_INDEX('Procedure', 'procedure_fts')`,
  `CALL DROP_FTS_INDEX('Provider', 'provider_fts')`,
  `CALL DROP_FTS_INDEX('Organization', 'organization_fts')`,
];

// ─── Schema lifecycle functions ───────────────────────────────────────────────

export async function createEhrSchema(conn: { query: (stmt: string) => Promise<unknown> }): Promise<void> {
  for (const stmt of EHR_NODE_TABLES) await conn.query(stmt);
  for (const stmt of EHR_REL_TABLES) await conn.query(stmt);
}

export async function createEhrFtsIndexes(conn: { query: (stmt: string) => Promise<unknown> }): Promise<void> {
  for (const stmt of EHR_FTS_INDEXES) {
    try { await conn.query(stmt); } catch { /* table may be empty */ }
  }
}

export async function rebuildEhrFtsIndexes(conn: { query: (stmt: string) => Promise<unknown> }): Promise<void> {
  for (const stmt of EHR_FTS_DROP) {
    try { await conn.query(stmt); } catch { /* index may not exist */ }
  }
  await createEhrFtsIndexes(conn);
}
