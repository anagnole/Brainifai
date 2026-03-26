/**
 * EHR Kuzu DDL — shared concept node model.
 *
 * Concept nodes (ConceptCondition, ConceptMedication, etc.) are shared
 * across patients. Clinical data (dates, values) lives on relationship
 * properties. Cross-concept edges (TREATS, INDICATED_BY, COMPLICATION_OF)
 * connect related medical concepts.
 */

// ─── Node Tables ─────────────────────────────────────────────────────────────

export const EHR_NODE_TABLES = [
  // Shared concept nodes (~1,200 total)
  `CREATE NODE TABLE IF NOT EXISTS ConceptCondition (
    code STRING, system STRING, description STRING,
    PRIMARY KEY (code)
  )`,
  `CREATE NODE TABLE IF NOT EXISTS ConceptMedication (
    code STRING, description STRING,
    PRIMARY KEY (code)
  )`,
  `CREATE NODE TABLE IF NOT EXISTS ConceptObservation (
    code STRING, description STRING, category STRING, units STRING, type STRING,
    PRIMARY KEY (code)
  )`,
  `CREATE NODE TABLE IF NOT EXISTS ConceptProcedure (
    code STRING, system STRING, description STRING,
    PRIMARY KEY (code)
  )`,

  // Instance nodes
  `CREATE NODE TABLE IF NOT EXISTS Patient (
    patient_id STRING, first_name STRING, last_name STRING,
    birth_date STRING, death_date STRING, gender STRING,
    race STRING, ethnicity STRING, marital_status STRING,
    city STRING, state STRING, zip STRING,
    PRIMARY KEY (patient_id)
  )`,
  `CREATE NODE TABLE IF NOT EXISTS Encounter (
    encounter_id STRING, patient_id STRING, provider_id STRING,
    organization_id STRING, encounter_class STRING, code STRING,
    description STRING, start_date STRING, stop_date STRING,
    reason_code STRING, reason_description STRING,
    PRIMARY KEY (encounter_id)
  )`,
  `CREATE NODE TABLE IF NOT EXISTS Provider (
    provider_id STRING, organization_id STRING, name STRING,
    gender STRING, specialty STRING,
    PRIMARY KEY (provider_id)
  )`,
  `CREATE NODE TABLE IF NOT EXISTS Organization (
    organization_id STRING, name STRING, city STRING,
    state STRING, zip STRING, phone STRING,
    PRIMARY KEY (organization_id)
  )`,
];

// ─── Relationship Tables ─────────────────────────────────────────────────────

export const EHR_REL_TABLES = [
  // Patient → concept (with clinical data on edges)
  `CREATE REL TABLE IF NOT EXISTS DIAGNOSED_WITH (
    FROM Patient TO ConceptCondition,
    start_date STRING, stop_date STRING, encounter_id STRING,
    MANY_MANY
  )`,
  `CREATE REL TABLE IF NOT EXISTS PRESCRIBED (
    FROM Patient TO ConceptMedication,
    start_date STRING, stop_date STRING, encounter_id STRING,
    reason_code STRING, reason_description STRING,
    MANY_MANY
  )`,
  `CREATE REL TABLE IF NOT EXISTS HAS_RESULT (
    FROM Patient TO ConceptObservation,
    value STRING, units STRING, date STRING, encounter_id STRING,
    category STRING, type STRING,
    MANY_MANY
  )`,
  `CREATE REL TABLE IF NOT EXISTS UNDERWENT (
    FROM Patient TO ConceptProcedure,
    start_date STRING, stop_date STRING, encounter_id STRING,
    reason_code STRING, reason_description STRING,
    MANY_MANY
  )`,

  // Patient → Encounter
  `CREATE REL TABLE IF NOT EXISTS HAD_ENCOUNTER (FROM Patient TO Encounter, MANY_MANY)`,

  // Encounter → infrastructure
  `CREATE REL TABLE IF NOT EXISTS TREATED_BY (FROM Encounter TO Provider, MANY_MANY)`,
  `CREATE REL TABLE IF NOT EXISTS AT_ORGANIZATION (FROM Encounter TO Organization, MANY_MANY)`,
  `CREATE REL TABLE IF NOT EXISTS AFFILIATED_WITH (FROM Provider TO Organization, MANY_MANY)`,

  // Cross-concept edges
  `CREATE REL TABLE IF NOT EXISTS TREATS (FROM ConceptMedication TO ConceptCondition, MANY_MANY)`,
  `CREATE REL TABLE IF NOT EXISTS INDICATED_BY (FROM ConceptProcedure TO ConceptCondition, MANY_MANY)`,
  `CREATE REL TABLE IF NOT EXISTS REASON_FOR (FROM Encounter TO ConceptCondition, MANY_MANY)`,
  `CREATE REL TABLE IF NOT EXISTS COMPLICATION_OF (FROM ConceptCondition TO ConceptCondition, MANY_MANY)`,
];

// ─── FTS Indexes ─────────────────────────────────────────────────────────────

export const EHR_FTS_INDEXES = [
  `CALL CREATE_FTS_INDEX('Patient', 'patient_fts', ['first_name', 'last_name', 'city'])`,
  `CALL CREATE_FTS_INDEX('ConceptCondition', 'condition_fts', ['description', 'code'])`,
  `CALL CREATE_FTS_INDEX('ConceptMedication', 'medication_fts', ['description', 'code'])`,
  `CALL CREATE_FTS_INDEX('ConceptObservation', 'observation_fts', ['description', 'code'])`,
  `CALL CREATE_FTS_INDEX('ConceptProcedure', 'procedure_fts', ['description', 'code'])`,
  `CALL CREATE_FTS_INDEX('Provider', 'provider_fts', ['name', 'specialty'])`,
  `CALL CREATE_FTS_INDEX('Organization', 'organization_fts', ['name', 'city'])`,
];

export const EHR_FTS_DROP = [
  `CALL DROP_FTS_INDEX('Patient', 'patient_fts')`,
  `CALL DROP_FTS_INDEX('ConceptCondition', 'condition_fts')`,
  `CALL DROP_FTS_INDEX('ConceptMedication', 'medication_fts')`,
  `CALL DROP_FTS_INDEX('ConceptObservation', 'observation_fts')`,
  `CALL DROP_FTS_INDEX('ConceptProcedure', 'procedure_fts')`,
  `CALL DROP_FTS_INDEX('Provider', 'provider_fts')`,
  `CALL DROP_FTS_INDEX('Organization', 'organization_fts')`,
];

// ─── Schema lifecycle functions ─────────────────────────────────────────────

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
