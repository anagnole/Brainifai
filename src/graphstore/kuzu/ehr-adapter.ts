/**
 * EHR-specific graph query adapter — shared concept node model.
 *
 * Clinical data (dates, values) lives on relationship properties.
 * Concept nodes are shared across patients.
 * Queries traverse Patient -[rel]-> ConceptX and read rel properties.
 */

import kuzu from 'kuzu';
import type { KuzuValue } from 'kuzu';
import { createEhrSchema, rebuildEhrFtsIndexes } from './ehr-schema.js';

// ─── Return types ─────────────────────────────────────────────────────────────

export interface PatientRecord {
  patient_id: string;
  first_name: string;
  last_name: string;
  birth_date: string;
  death_date: string | null;
  gender: string;
  race: string;
  ethnicity: string;
  marital_status: string;
  city: string;
  state: string;
  zip: string;
}

export interface ConditionRecord {
  code: string;
  system: string;
  description: string;
  start_date: string;
  stop_date: string | null;
  encounter_id: string;
}

export interface MedicationRecord {
  code: string;
  description: string;
  start_date: string;
  stop_date: string | null;
  reason_code: string;
  reason_description: string;
  encounter_id: string;
}

export interface ObservationRecord {
  category: string;
  code: string;
  description: string;
  value: string;
  units: string;
  type: string;
  date: string;
  encounter_id: string;
}

export interface ProcedureRecord {
  code: string;
  system: string;
  description: string;
  start_date: string;
  stop_date: string;
  reason_code: string;
  reason_description: string;
  encounter_id: string;
}

export interface EncounterRecord {
  encounter_id: string;
  encounter_class: string;
  code: string;
  description: string;
  start_date: string;
  stop_date: string;
  reason_code: string;
  reason_description: string;
  provider_id: string;
  provider_name: string | null;
  provider_specialty: string | null;
  organization_id: string;
}

export interface PatientSummary {
  patient: PatientRecord;
  conditions: ConditionRecord[];
  medications: MedicationRecord[];
  observations: ObservationRecord[];
  procedures: ProcedureRecord[];
  encounters: EncounterRecord[];
}

export interface TemporalRelationResult {
  from_date: string;
  to_date: string;
  relation: 'before' | 'after' | 'same_day';
}

// ─── EhrGraphStore ────────────────────────────────────────────────────────────

export class EhrGraphStore {
  private db: InstanceType<typeof kuzu.Database>;
  private conn: InstanceType<typeof kuzu.Connection>;

  constructor(config: { dbPath: string; readOnly?: boolean }) {
    this.db = new kuzu.Database(config.dbPath, 0, true, config.readOnly ?? false);
    this.conn = new kuzu.Connection(this.db);
  }

  async initialize(): Promise<void> {
    await this.conn.query('LOAD EXTENSION fts');
    await createEhrSchema(this.conn);
  }

  async rebuildFtsIndexes(): Promise<void> {
    await rebuildEhrFtsIndexes(this.conn);
  }

  async close(): Promise<void> {
    await this.conn.close();
    await this.db.close();
  }

  private async query(cypher: string, params?: Record<string, KuzuValue>): Promise<Record<string, KuzuValue>[]> {
    let rows: Record<string, KuzuValue>[];
    if (params && Object.keys(params).length > 0) {
      const ps = await this.conn.prepare(cypher);
      const result = await this.conn.execute(ps, params);
      const qr = Array.isArray(result) ? result[0] : result;
      rows = await qr.getAll();
    } else {
      const result = await this.conn.query(cypher);
      const qr = Array.isArray(result) ? result[0] : result;
      rows = await qr.getAll();
    }
    // Kuzu returns DATE columns as JS Date objects. Normalize to YYYY-MM-DD
    // strings so downstream "as string" casts and JSON responses stay stable.
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        const v = row[k];
        if (v instanceof Date) row[k] = v.toISOString().slice(0, 10) as KuzuValue;
      }
    }
    return rows;
  }

  // ─── Patient Summary ──────────────────────────────────────────────────────

  async getPatientSummary(patientId: string): Promise<PatientSummary | null> {
    const patients = await this.query(
      `MATCH (p:Patient {patient_id: $id}) RETURN p`,
      { id: patientId },
    );
    if (patients.length === 0) return null;

    const p = patients[0].p as Record<string, KuzuValue>;

    const [conditions, medications, observations, procedures, encounters] = await Promise.all([
      this.query(
        `MATCH (p:Patient {patient_id: $id})-[r:DIAGNOSED_WITH]->(c:ConceptCondition)
         RETURN c.code AS code, c.system AS system, c.description AS description,
                r.start_date AS start_date, r.stop_date AS stop_date,
                r.encounter_id AS encounter_id`,
        { id: patientId },
      ),
      this.query(
        `MATCH (p:Patient {patient_id: $id})-[r:PRESCRIBED]->(m:ConceptMedication)
         RETURN m.code AS code, m.description AS description,
                r.start_date AS start_date, r.stop_date AS stop_date,
                r.reason_code AS reason_code, r.reason_description AS reason_description,
                r.encounter_id AS encounter_id`,
        { id: patientId },
      ),
      this.query(
        `MATCH (p:Patient {patient_id: $id})-[r:HAS_RESULT]->(o:ConceptObservation)
         RETURN o.code AS code, o.description AS description,
                r.value AS value, r.units AS units, r.type AS type,
                r.date AS date, r.category AS category,
                r.encounter_id AS encounter_id`,
        { id: patientId },
      ),
      this.query(
        `MATCH (p:Patient {patient_id: $id})-[r:UNDERWENT]->(pr:ConceptProcedure)
         RETURN pr.code AS code, pr.system AS system, pr.description AS description,
                r.start_date AS start_date, r.stop_date AS stop_date,
                r.reason_code AS reason_code, r.reason_description AS reason_description,
                r.encounter_id AS encounter_id`,
        { id: patientId },
      ),
      this.query(
        `MATCH (p:Patient {patient_id: $id})-[:HAD_ENCOUNTER]->(e:Encounter)
         OPTIONAL MATCH (e)-[:TREATED_BY]->(prov:Provider)
         RETURN e.encounter_id AS encounter_id, e.encounter_class AS encounter_class,
                e.code AS code, e.description AS description,
                e.start_date AS start_date, e.stop_date AS stop_date,
                e.reason_code AS reason_code, e.reason_description AS reason_description,
                e.provider_id AS provider_id, e.organization_id AS organization_id,
                prov.name AS provider_name, prov.specialty AS provider_specialty`,
        { id: patientId },
      ),
    ]);

    return {
      patient: {
        patient_id: p.patient_id as string,
        first_name: p.first_name as string,
        last_name: p.last_name as string,
        birth_date: p.birth_date as string,
        death_date: (p.death_date as string) || null,
        gender: p.gender as string,
        race: p.race as string,
        ethnicity: p.ethnicity as string,
        marital_status: p.marital_status as string,
        city: p.city as string,
        state: p.state as string,
        zip: p.zip as string,
      },
      conditions: conditions.map((r) => ({
        code: r.code as string,
        system: r.system as string,
        description: r.description as string,
        start_date: r.start_date as string,
        stop_date: (r.stop_date as string) || null,
        encounter_id: r.encounter_id as string,
      })),
      medications: medications.map((r) => ({
        code: r.code as string,
        description: r.description as string,
        start_date: r.start_date as string,
        stop_date: (r.stop_date as string) || null,
        reason_code: r.reason_code as string,
        reason_description: r.reason_description as string,
        encounter_id: r.encounter_id as string,
      })),
      observations: observations.map((r) => ({
        category: r.category as string,
        code: r.code as string,
        description: r.description as string,
        value: r.value as string,
        units: r.units as string,
        type: r.type as string,
        date: r.date as string,
        encounter_id: r.encounter_id as string,
      })),
      procedures: procedures.map((r) => ({
        code: r.code as string,
        system: r.system as string,
        description: r.description as string,
        start_date: r.start_date as string,
        stop_date: r.stop_date as string,
        reason_code: r.reason_code as string,
        reason_description: r.reason_description as string,
        encounter_id: r.encounter_id as string,
      })),
      encounters: encounters.map((r) => ({
        encounter_id: r.encounter_id as string,
        encounter_class: r.encounter_class as string,
        code: r.code as string,
        description: r.description as string,
        start_date: r.start_date as string,
        stop_date: r.stop_date as string,
        reason_code: r.reason_code as string,
        reason_description: r.reason_description as string,
        provider_id: r.provider_id as string,
        provider_name: (r.provider_name as string) || null,
        provider_specialty: (r.provider_specialty as string) || null,
        organization_id: r.organization_id as string,
      })),
    };
  }

  // ─── Medications ──────────────────────────────────────────────────────────

  async getPatientMedications(
    patientId: string,
    opts?: { active?: boolean; name?: string },
  ): Promise<MedicationRecord[]> {
    const filters = ['p.patient_id = $id'];
    const params: Record<string, KuzuValue> = { id: patientId };

    if (opts?.active) {
      filters.push("r.stop_date IS NULL");
    }
    if (opts?.name) {
      filters.push('m.description CONTAINS $name');
      params.name = opts.name;
    }

    const rows = await this.query(
      `MATCH (p:Patient)-[r:PRESCRIBED]->(m:ConceptMedication)
       WHERE ${filters.join(' AND ')}
       RETURN m.code AS code, m.description AS description,
              r.start_date AS start_date, r.stop_date AS stop_date,
              r.reason_code AS reason_code, r.reason_description AS reason_description,
              r.encounter_id AS encounter_id
       ORDER BY r.start_date DESC`,
      params,
    );

    return rows.map((r) => ({
      code: r.code as string,
      description: r.description as string,
      start_date: r.start_date as string,
      stop_date: (r.stop_date as string) || null,
      reason_code: r.reason_code as string,
      reason_description: r.reason_description as string,
      encounter_id: r.encounter_id as string,
    }));
  }

  // ─── Conditions ───────────────────────────────────────────────────────────

  async getPatientConditions(
    patientId: string,
    opts?: { status?: 'active' | 'resolved'; includeFindings?: boolean },
  ): Promise<ConditionRecord[]> {
    const filters = ['p.patient_id = $id'];
    const params: Record<string, KuzuValue> = { id: patientId };

    if (opts?.status === 'active') {
      filters.push("r.stop_date IS NULL");
    } else if (opts?.status === 'resolved') {
      filters.push("r.stop_date IS NOT NULL");
    }
    // Synthea encodes SDoH ("Full-time employment", "Educated to high school
    // level") as SNOMED 'finding' concepts on the same DIAGNOSED_WITH edge as
    // clinical 'disorder' entries. Exclude findings by default so "list active
    // problems" returns medical diagnoses, not social context. BUT some
    // findings are clinically meaningful (Prediabetes, Hyperglycemia etc.) —
    // let those through via an allow-list. Mirrors the ThesisBrainifai
    // in-process tool (src/api/tools.ts findingsAllowlistCypher).
    if (!opts?.includeFindings) {
      const allowlist = [
        "'Prediabetes (finding)'",
        "'Hypoxemia (finding)'",
        "'Hyperglycemia (finding)'",
        "'Hypoglycemia (finding)'",
        "'Proteinuria (finding)'",
        "'Microalbuminuria (finding)'",
        "'Loss of taste (finding)'",
      ].join(', ');
      filters.push(`(NOT c.description ENDS WITH '(finding)' OR c.description IN [${allowlist}])`);
    }

    const rows = await this.query(
      `MATCH (p:Patient)-[r:DIAGNOSED_WITH]->(c:ConceptCondition)
       WHERE ${filters.join(' AND ')}
       RETURN c.code AS code, c.system AS system, c.description AS description,
              r.start_date AS start_date, r.stop_date AS stop_date,
              r.encounter_id AS encounter_id
       ORDER BY r.start_date DESC`,
      params,
    );

    return rows.map((r) => ({
      code: r.code as string,
      system: r.system as string,
      description: r.description as string,
      start_date: r.start_date as string,
      stop_date: (r.stop_date as string) || null,
      encounter_id: r.encounter_id as string,
    }));
  }

  // ─── Labs (Observations) ──────────────────────────────────────────────────

  async getPatientLabs(
    patientId: string,
    opts?: { code?: string; startDate?: string; endDate?: string },
  ): Promise<ObservationRecord[]> {
    const filters = ['p.patient_id = $id'];
    const params: Record<string, KuzuValue> = { id: patientId };

    if (opts?.code) {
      filters.push('o.code = $code');
      params.code = opts.code;
    }
    if (opts?.startDate) {
      filters.push('r.date >= $startDate');
      params.startDate = opts.startDate;
    }
    if (opts?.endDate) {
      filters.push('r.date <= $endDate');
      params.endDate = opts.endDate;
    }

    const rows = await this.query(
      `MATCH (p:Patient)-[r:HAS_RESULT]->(o:ConceptObservation)
       WHERE ${filters.join(' AND ')}
       RETURN o.code AS code, o.description AS description,
              r.value AS value, r.units AS units, r.type AS type,
              r.date AS date, r.category AS category,
              r.encounter_id AS encounter_id
       ORDER BY r.date DESC`,
      params,
    );

    return rows.map((r) => ({
      category: r.category as string,
      code: r.code as string,
      description: r.description as string,
      value: r.value as string,
      units: r.units as string,
      type: r.type as string,
      date: r.date as string,
      encounter_id: r.encounter_id as string,
    }));
  }

  // ─── Temporal Relation ────────────────────────────────────────────────────

  async getTemporalRelation(
    patientId: string,
    opts: { fromType: string; fromId: string; toType: string; toId: string },
  ): Promise<TemporalRelationResult | null> {
    const fromDateQuery = this.dateQueryForType(opts.fromType, opts.fromId, patientId);
    const toDateQuery = this.dateQueryForType(opts.toType, opts.toId, patientId);

    const [fromRows, toRows] = await Promise.all([
      this.query(fromDateQuery.cypher, fromDateQuery.params),
      this.query(toDateQuery.cypher, toDateQuery.params),
    ]);

    if (fromRows.length === 0 || toRows.length === 0) return null;

    const fromDate = fromRows[0].date as string;
    const toDate = toRows[0].date as string;

    let relation: 'before' | 'after' | 'same_day';
    if (fromDate < toDate) relation = 'before';
    else if (fromDate > toDate) relation = 'after';
    else relation = 'same_day';

    return { from_date: fromDate, to_date: toDate, relation };
  }

  private dateQueryForType(type: string, code: string, patientId: string) {
    const params: Record<string, KuzuValue> = { code, pid: patientId };
    switch (type.toLowerCase()) {
      case 'condition':
        return {
          cypher: `MATCH (p:Patient {patient_id: $pid})-[r:DIAGNOSED_WITH]->(c:ConceptCondition {code: $code})
                   RETURN r.start_date AS date ORDER BY r.start_date LIMIT 1`,
          params,
        };
      case 'medication':
        return {
          cypher: `MATCH (p:Patient {patient_id: $pid})-[r:PRESCRIBED]->(m:ConceptMedication {code: $code})
                   RETURN r.start_date AS date ORDER BY r.start_date LIMIT 1`,
          params,
        };
      case 'observation':
        return {
          cypher: `MATCH (p:Patient {patient_id: $pid})-[r:HAS_RESULT]->(o:ConceptObservation {code: $code})
                   RETURN r.date AS date ORDER BY r.date LIMIT 1`,
          params,
        };
      case 'procedure':
        return {
          cypher: `MATCH (p:Patient {patient_id: $pid})-[r:UNDERWENT]->(pr:ConceptProcedure {code: $code})
                   RETURN r.start_date AS date ORDER BY r.start_date LIMIT 1`,
          params,
        };
      case 'encounter':
        return {
          cypher: `MATCH (e:Encounter {encounter_id: $code}) WHERE e.patient_id = $pid
                   RETURN e.start_date AS date`,
          params,
        };
      default:
        return {
          cypher: `MATCH (p:Patient {patient_id: $pid})-[r:DIAGNOSED_WITH]->(c:ConceptCondition {code: $code})
                   RETURN r.start_date AS date ORDER BY r.start_date LIMIT 1`,
          params,
        };
    }
  }

  // ─── Cohort Discovery ─────────────────────────────────────────────────────

  async findCohort(opts: {
    conditions?: string[];
    medications?: string[];
    ageRange?: [number, number];
    gender?: string;
  }): Promise<PatientRecord[]> {
    const matchClauses: string[] = ['MATCH (p:Patient)'];
    const filters: string[] = [];
    const params: Record<string, KuzuValue> = {};

    // Case-insensitive condition/medication matching — the question generator
    // uses .toLowerCase().includes(...), and Synthea descriptions mix case
    // (e.g. "Diabetes mellitus type 2" vs "Disorder of kidney due to diabetes
    // mellitus"). Without LOWER on both sides, a search for "Diabetes" misses
    // the second one, under-counting cohorts by ~50%.
    if (opts.conditions && opts.conditions.length > 0) {
      for (let i = 0; i < opts.conditions.length; i++) {
        matchClauses.push(`MATCH (p)-[:DIAGNOSED_WITH]->(c${i}:ConceptCondition)`);
        filters.push(`LOWER(c${i}.description) CONTAINS LOWER($cond${i})`);
        params[`cond${i}`] = opts.conditions[i];
      }
    }

    if (opts.medications && opts.medications.length > 0) {
      for (let i = 0; i < opts.medications.length; i++) {
        matchClauses.push(`MATCH (p)-[:PRESCRIBED]->(m${i}:ConceptMedication)`);
        filters.push(`LOWER(m${i}.description) CONTAINS LOWER($med${i})`);
        params[`med${i}`] = opts.medications[i];
      }
    }

    if (opts.gender) {
      filters.push('p.gender = $gender');
      params.gender = opts.gender;
    }

    const whereClause = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';

    const rows = await this.query(
      `${matchClauses.join('\n')}
       ${whereClause}
       RETURN DISTINCT p.patient_id AS patient_id, p.first_name AS first_name,
              p.last_name AS last_name, p.birth_date AS birth_date,
              p.death_date AS death_date, p.gender AS gender,
              p.race AS race, p.ethnicity AS ethnicity,
              p.marital_status AS marital_status, p.city AS city,
              p.state AS state, p.zip AS zip
       LIMIT 100`,
      params,
    );

    let results = rows.map((r) => ({
      patient_id: r.patient_id as string,
      first_name: r.first_name as string,
      last_name: r.last_name as string,
      birth_date: r.birth_date as string,
      death_date: (r.death_date as string) || null,
      gender: r.gender as string,
      race: r.race as string,
      ethnicity: r.ethnicity as string,
      marital_status: r.marital_status as string,
      city: r.city as string,
      state: r.state as string,
      zip: r.zip as string,
    }));

    if (opts.ageRange) {
      const now = new Date();
      results = results.filter((p) => {
        const birth = new Date(p.birth_date);
        const age = (now.getTime() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        return age >= opts.ageRange![0] && age <= opts.ageRange![1];
      });
    }

    return results;
  }

  // ─── Cohort Count (efficient count-only for cohort counting questions) ───

  /**
   * Count distinct patients matching the given cohort criteria without
   * returning patient records. Use for "how many patients have X" questions —
   * find_cohort caps at 100 records AND returns a heavy payload, which is
   * wrong for counting and blows context on large tiers. This method runs a
   * single count query and returns the exact number.
   */
  async countCohort(opts: {
    conditions?: string[];
    medications?: string[];
    ageRange?: [number, number];
    gender?: string;
  }): Promise<number> {
    const matchClauses: string[] = ['MATCH (p:Patient)'];
    const filters: string[] = [];
    const params: Record<string, KuzuValue> = {};

    if (opts.conditions && opts.conditions.length > 0) {
      for (let i = 0; i < opts.conditions.length; i++) {
        matchClauses.push(`MATCH (p)-[:DIAGNOSED_WITH]->(c${i}:ConceptCondition)`);
        filters.push(`LOWER(c${i}.description) CONTAINS LOWER($cond${i})`);
        params[`cond${i}`] = opts.conditions[i];
      }
    }

    if (opts.medications && opts.medications.length > 0) {
      for (let i = 0; i < opts.medications.length; i++) {
        matchClauses.push(`MATCH (p)-[:PRESCRIBED]->(m${i}:ConceptMedication)`);
        filters.push(`LOWER(m${i}.description) CONTAINS LOWER($med${i})`);
        params[`med${i}`] = opts.medications[i];
      }
    }

    if (opts.gender) {
      filters.push('p.gender = $gender');
      params.gender = opts.gender;
    }

    const whereClause = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';

    // Note: age filter is applied post-query because birth_date is a string
    // column and we need JS date math to compute age at "now".
    const rows = await this.query(
      `${matchClauses.join('\n')}
       ${whereClause}
       RETURN DISTINCT p.patient_id AS patient_id, p.birth_date AS birth_date`,
      params,
    );

    let results = rows.map((r) => ({
      patient_id: r.patient_id as string,
      birth_date: r.birth_date as string,
    }));

    if (opts.ageRange) {
      const now = new Date();
      results = results.filter((p) => {
        const birth = new Date(p.birth_date);
        const age = (now.getTime() - birth.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
        return age >= opts.ageRange![0] && age <= opts.ageRange![1];
      });
    }

    return results.length;
  }

  // ─── Patient Search (FTS) ─────────────────────────────────────────────────

  async searchPatients(queryText: string, limit = 20): Promise<PatientRecord[]> {
    const safeQuery = queryText.replace(/'/g, "''");
    const rows = await this.query(
      `CALL QUERY_FTS_INDEX('Patient', 'patient_fts', '${safeQuery}')
       RETURN node.patient_id AS patient_id, node.first_name AS first_name,
              node.last_name AS last_name, node.birth_date AS birth_date,
              node.death_date AS death_date, node.gender AS gender,
              node.race AS race, node.ethnicity AS ethnicity,
              node.marital_status AS marital_status, node.city AS city,
              node.state AS state, node.zip AS zip, score
       ORDER BY score DESC
       LIMIT ${limit}`,
    );

    return rows.map((r) => ({
      patient_id: r.patient_id as string,
      first_name: r.first_name as string,
      last_name: r.last_name as string,
      birth_date: r.birth_date as string,
      death_date: (r.death_date as string) || null,
      gender: r.gender as string,
      race: r.race as string,
      ethnicity: r.ethnicity as string,
      marital_status: r.marital_status as string,
      city: r.city as string,
      state: r.state as string,
      zip: r.zip as string,
    }));
  }

  // ─── Observation Concept Search (FTS) ─────────────────────────────────────

  /**
   * Search for ConceptObservation nodes by clinical name. Returns LOINC code,
   * official description, units, and FTS relevance score. Use this to bridge
   * clinical shorthand ("Total Cholesterol") to LOINC's verbose descriptions
   * ("Cholesterol [Mass/volume] in Serum or Plasma") which the data uses.
   */
  async findObservationConcepts(
    queryText: string,
    limit = 10,
  ): Promise<Array<{ code: string; description: string; units: string; score: number }>> {
    const safeQuery = queryText.replace(/'/g, "''");
    const rows = await this.query(
      `CALL QUERY_FTS_INDEX('ConceptObservation', 'observation_fts', '${safeQuery}')
       RETURN node.code AS code, node.description AS description, node.units AS units, score
       ORDER BY score DESC LIMIT ${limit}`,
    );
    return rows.map((r) => ({
      code: r.code as string,
      description: r.description as string,
      units: (r.units as string) ?? '',
      score: Number(r.score ?? 0),
    }));
  }

  // ─── Cohort Aggregation (server-side) ─────────────────────────────────────

  /**
   * Compute an aggregate (avg/min/max/sum/count/median) of the most-recent
   * observation value across a cohort of patients matching a condition. This
   * exists so the LLM agent can answer cohort questions like "average X for
   * patients with Y" in a single tool call instead of looping get_labs per
   * patient (which blows the context window).
   */
  async aggregateObservationForCohort(opts: {
    condition: string;
    observationCode?: string;
    observationDescription?: string;
    aggregation: 'avg' | 'min' | 'max' | 'sum' | 'count' | 'median';
  }): Promise<{
    cohort_size: number;
    patients_with_observation: number;
    aggregation: string;
    value: number | null;
    units: string | null;
    observation_description: string | null;
    note?: string;
  }> {
    const { condition, observationCode, observationDescription, aggregation } = opts;

    if (!observationCode && !observationDescription) {
      throw new Error("Either observationCode or observationDescription is required");
    }

    // Cohort size: distinct patients matching the condition (case-insensitive
    // to match question generator semantics — Synthea mixes "Diabetes"
    // and "diabetes" across related descriptions).
    const cohortRows = await this.query(
      `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
       WHERE LOWER(c.description) CONTAINS LOWER($cond)
       RETURN count(DISTINCT p) AS cnt`,
      { cond: condition },
    );
    const cohortSize = Number(cohortRows[0]?.cnt ?? 0);

    if (cohortSize === 0) {
      return {
        cohort_size: 0,
        patients_with_observation: 0,
        aggregation,
        value: null,
        units: null,
        observation_description: null,
        note: `No patients found matching condition '${condition}'`,
      };
    }

    // Pull all (patient, value, date) tuples for cohort+observation, find latest per patient in JS.
    // Avoids fighting Kuzu's CAST/aggregation semantics on string-typed FHIR values.
    const obsParam = observationCode ?? observationDescription!;
    const obsFilter = observationCode ? 'o.code = $obs' : 'LOWER(o.description) CONTAINS LOWER($obs)';
    const rows = await this.query(
      `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
       WHERE LOWER(c.description) CONTAINS LOWER($cond)
       MATCH (p)-[r:HAS_RESULT]->(o:ConceptObservation)
       WHERE ${obsFilter}
       RETURN p.patient_id AS pid, r.value AS value, r.units AS units, r.date AS date, o.description AS description`,
      { cond: condition, obs: obsParam },
    );

    interface Latest { value: number; units: string; desc: string; date: string }
    const latestByPatient = new Map<string, Latest>();
    for (const row of rows) {
      const pid = row.pid as string;
      const raw = row.value;
      const value = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
      if (!Number.isFinite(value)) continue;
      const date = String(row.date ?? '');
      const existing = latestByPatient.get(pid);
      if (!existing || date > existing.date) {
        latestByPatient.set(pid, {
          value,
          units: String(row.units ?? ''),
          desc: String(row.description ?? ''),
          date,
        });
      }
    }

    const values = Array.from(latestByPatient.values()).map((v) => v.value);
    if (values.length === 0) {
      return {
        cohort_size: cohortSize,
        patients_with_observation: 0,
        aggregation,
        value: null,
        units: null,
        observation_description: observationDescription ?? observationCode ?? null,
        note: 'No numeric observations found for the cohort',
      };
    }

    let result: number;
    switch (aggregation) {
      case 'avg':
        result = values.reduce((a, b) => a + b, 0) / values.length;
        break;
      case 'min':
        result = Math.min(...values);
        break;
      case 'max':
        result = Math.max(...values);
        break;
      case 'sum':
        result = values.reduce((a, b) => a + b, 0);
        break;
      case 'count':
        result = values.length;
        break;
      case 'median': {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        result = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        break;
      }
      default:
        result = NaN;
    }

    const sample = latestByPatient.values().next().value as Latest;
    return {
      cohort_size: cohortSize,
      patients_with_observation: latestByPatient.size,
      aggregation,
      value: Math.round(result * 100) / 100,
      units: sample.units || null,
      observation_description: sample.desc || null,
    };
  }

  // ─── Patient Age ──────────────────────────────────────────────────────────

  /**
   * Calendar-correct age calculation. Returns age at `asOf` (defaults to today),
   * clamped to age-at-death if the patient was deceased before `asOf`.
   */
  async getPatientAge(patientId: string, asOf?: string): Promise<{
    patient_id: string;
    age_years: number;
    birth_date: string;
    as_of: string;
    deceased: boolean;
  } | { error: string }> {
    const rows = await this.query(
      `MATCH (p:Patient {patient_id: $id})
       RETURN p.birth_date AS birth_date, p.death_date AS death_date`,
      { id: patientId },
    );
    if (rows.length === 0) return { error: `Patient ${patientId} not found` };
    const birth = String(rows[0].birth_date ?? '');
    if (!birth) return { error: `Patient ${patientId} has no birth_date` };
    const death = String(rows[0].death_date ?? '');
    const today = new Date().toISOString().slice(0, 10);
    const target = asOf ?? today;
    const reference = death && death < target ? death : target;
    const b = new Date(birth);
    const a = new Date(reference);
    let years = a.getUTCFullYear() - b.getUTCFullYear();
    const monthDiff = a.getUTCMonth() - b.getUTCMonth();
    const dayDiff = a.getUTCDate() - b.getUTCDate();
    if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) years--;
    return {
      patient_id: patientId,
      age_years: years,
      birth_date: birth,
      as_of: reference,
      deceased: Boolean(death) && death <= target,
    };
  }

  // ─── Compare Observations ────────────────────────────────────────────────

  /**
   * Compare two values of the same lab for a patient. Default pair is
   * earliest vs. most-recent; pass dateA/dateB to pick the values nearest
   * those dates. Prefers value_canonical (unit-normalized at ingest).
   */
  async compareObservations(opts: {
    patientId: string;
    observationCode: string;
    dateA?: string;
    dateB?: string;
  }): Promise<Record<string, unknown>> {
    const rows = await this.query(
      `MATCH (:Patient {patient_id: $id})-[r:HAS_RESULT]->(o:ConceptObservation {code: $code})
       RETURN r.value AS value, r.units AS units,
              r.value_canonical AS vc, r.units_canonical AS uc,
              r.date AS date, o.description AS description
       ORDER BY r.date ASC`,
      { id: opts.patientId, code: opts.observationCode },
    );
    if (rows.length === 0) {
      return { error: `No observations with code ${opts.observationCode} found for patient ${opts.patientId}` };
    }

    // Replace raw value/units with canonical when available
    for (const r of rows) {
      const vc = r.vc;
      if (typeof vc === 'number' && Number.isFinite(vc)) {
        r.value = vc as KuzuValue;
        r.units = (r.uc ?? r.units) as KuzuValue;
      }
    }

    if (rows.length === 1) {
      return {
        single_value: true,
        value: rows[0].value,
        units: rows[0].units,
        date: rows[0].date,
        description: rows[0].description,
        note: 'Only one observation exists; nothing to compare against.',
      };
    }

    const numeric = rows
      .map((r) => ({ raw: r, num: typeof r.value === 'number' ? r.value : parseFloat(String(r.value ?? '')) }))
      .filter((r) => Number.isFinite(r.num));
    if (numeric.length < 2) {
      return { error: `Observations exist but fewer than two have numeric values for code ${opts.observationCode}` };
    }

    const pickNearest = (target: string) =>
      numeric.reduce((best, cur) => {
        const bg = Math.abs(new Date(String(best.raw.date)).getTime() - new Date(target).getTime());
        const cg = Math.abs(new Date(String(cur.raw.date)).getTime() - new Date(target).getTime());
        return cg < bg ? cur : best;
      });

    const pa = opts.dateA ? pickNearest(opts.dateA) : numeric[0];
    const pb = opts.dateB ? pickNearest(opts.dateB) : numeric[numeric.length - 1];
    const delta = pb.num - pa.num;
    const days = Math.round(
      (new Date(String(pb.raw.date)).getTime() - new Date(String(pa.raw.date)).getTime()) / 86_400_000,
    );
    const direction = Math.abs(delta) < 1e-9 ? 'stable' : delta > 0 ? 'rising' : 'falling';

    return {
      observation_code: opts.observationCode,
      description: pa.raw.description,
      value_a: pa.num,
      date_a: pa.raw.date,
      value_b: pb.num,
      date_b: pb.raw.date,
      units: pa.raw.units,
      delta: Math.round(delta * 100) / 100,
      direction,
      days_between: Math.abs(days),
    };
  }

  // ─── Cohort Observation Distribution ─────────────────────────────────────

  async cohortObservationDistribution(opts: {
    condition: string;
    observationCode?: string;
    observationDescription?: string;
    thresholds?: number[];
  }): Promise<Record<string, unknown>> {
    const { condition, observationCode, observationDescription, thresholds } = opts;
    if (!observationCode && !observationDescription) {
      throw new Error('Either observationCode or observationDescription is required');
    }
    const obsFilter = observationCode ? 'o.code = $obs' : 'LOWER(o.description) CONTAINS LOWER($obs)';
    const obsParam = observationCode ?? observationDescription!;

    const rows = await this.query(
      `MATCH (p:Patient)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
       WHERE LOWER(c.description) CONTAINS LOWER($cond)
       MATCH (p)-[r:HAS_RESULT]->(o:ConceptObservation)
       WHERE ${obsFilter}
       RETURN p.patient_id AS pid, r.value AS value, r.units AS units,
              r.value_canonical AS vc, r.units_canonical AS uc,
              r.date AS date, o.description AS description`,
      { cond: condition, obs: obsParam },
    );

    interface Latest { value: number; units: string; desc: string; date: string }
    const latest = new Map<string, Latest>();
    for (const row of rows) {
      const pid = row.pid as string;
      const vc = row.vc;
      const hasCanonical = typeof vc === 'number' && Number.isFinite(vc);
      const value = hasCanonical
        ? (vc as number)
        : typeof row.value === 'number' ? row.value : parseFloat(String(row.value ?? ''));
      if (!Number.isFinite(value)) continue;
      const units = hasCanonical ? String(row.uc ?? '') : String(row.units ?? '');
      const d = String(row.date ?? '');
      const existing = latest.get(pid);
      if (!existing || d > existing.date) {
        latest.set(pid, { value, units, desc: String(row.description ?? ''), date: d });
      }
    }

    const values = [...latest.values()].map((l) => l.value);
    if (values.length === 0) {
      return {
        cohort_size: 0,
        observation_description: observationDescription ?? observationCode,
        buckets: [],
        note: `No numeric observations for condition '${condition}'`,
      };
    }

    const ts = thresholds && thresholds.length > 0
      ? [...thresholds].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
      : null;
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const boundaries = ts && ts.length > 0
      ? ts
      : (() => {
          if (minV === maxV) return [minV];
          const step = (maxV - minV) / 5;
          return [1, 2, 3, 4].map((i) => minV + step * i);
        })();

    const counts = new Array(boundaries.length + 1).fill(0);
    for (const v of values) {
      let placed = false;
      for (let i = 0; i < boundaries.length; i++) {
        if (v <= boundaries[i]) { counts[i]++; placed = true; break; }
      }
      if (!placed) counts[counts.length - 1]++;
    }
    const labels = boundaries.map((b, i) => {
      const lower = i === 0 ? '-inf' : String(boundaries[i - 1]);
      return `(${lower}, ${b}]`;
    });
    labels.push(`(${boundaries[boundaries.length - 1]}, +inf)`);

    const sample = latest.values().next().value as Latest;
    return {
      cohort_size: latest.size,
      observation_description: sample.desc,
      units: sample.units || null,
      min: Math.round(minV * 100) / 100,
      max: Math.round(maxV * 100) / 100,
      buckets: labels.map((label, i) => ({ range: label, count: counts[i] })),
      thresholds_used: boundaries,
    };
  }

  // ─── Medication Adherence ─────────────────────────────────────────────────

  async getMedicationAdherence(opts: {
    patientId: string;
    medicationCode?: string;
    medicationName?: string;
  }): Promise<Record<string, unknown>> {
    const { patientId, medicationCode, medicationName } = opts;
    if (!medicationCode && !medicationName) {
      return { error: 'Either medicationCode or medicationName is required' };
    }
    const filter = medicationCode ? 'm.code = $code' : 'LOWER(m.description) CONTAINS LOWER($name)';
    const params: Record<string, KuzuValue> = { id: patientId };
    if (medicationCode) params.code = medicationCode; else params.name = medicationName!;

    const rows = await this.query(
      `MATCH (:Patient {patient_id: $id})-[r:PRESCRIBED]->(m:ConceptMedication)
       WHERE ${filter}
       RETURN m.code AS code, m.description AS description,
              r.start_date AS start_date, r.stop_date AS stop_date
       ORDER BY r.start_date ASC`,
      params,
    );
    if (rows.length === 0) {
      return { error: `No prescriptions matching ${medicationCode ?? medicationName} for patient ${patientId}` };
    }

    interface Pair { start: string; stop: string | null }
    const byMed = new Map<string, { description: string; pairs: Pair[] }>();
    for (const r of rows) {
      const rx = r.code as string;
      if (!byMed.has(rx)) byMed.set(rx, { description: r.description as string, pairs: [] });
      byMed.get(rx)!.pairs.push({
        start: String(r.start_date),
        stop: r.stop_date ? String(r.stop_date) : null,
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const perMed = [...byMed.entries()].map(([rx, info]) => {
      const pairs = [...info.pairs].sort((a, b) => a.start.localeCompare(b.start));
      let totalDaysOnMed = 0;
      let totalGapDays = 0;
      const gaps: { gap_days: number; between_stop: string; next_start: string }[] = [];
      for (let i = 0; i < pairs.length; i++) {
        const p = pairs[i];
        const effectiveStop = p.stop ?? today;
        totalDaysOnMed += Math.max(0, Math.round(
          (new Date(effectiveStop).getTime() - new Date(p.start).getTime()) / 86_400_000,
        ));
        if (p.stop && i < pairs.length - 1) {
          const nextStart = pairs[i + 1].start;
          if (nextStart > p.stop) {
            const gapDays = Math.round(
              (new Date(nextStart).getTime() - new Date(p.stop).getTime()) / 86_400_000,
            );
            if (gapDays > 0) {
              totalGapDays += gapDays;
              gaps.push({ gap_days: gapDays, between_stop: p.stop, next_start: nextStart });
            }
          }
        }
      }
      const totalSpan = totalDaysOnMed + totalGapDays;
      const coverageRatio = totalSpan > 0 ? totalDaysOnMed / totalSpan : null;
      const adherence = coverageRatio == null ? null
        : coverageRatio >= 0.8 ? 'adherent'
        : coverageRatio >= 0.5 ? 'partial' : 'poor';
      return {
        medication_code: rx,
        description: info.description,
        prescription_count: pairs.length,
        first_start: pairs[0].start,
        last_start: pairs[pairs.length - 1].start,
        currently_active: pairs.some((p) => p.stop === null),
        days_covered: totalDaysOnMed,
        gap_days: totalGapDays,
        coverage_ratio: coverageRatio == null ? null : Math.round(coverageRatio * 100) / 100,
        adherence,
        gaps,
      };
    });

    return { patient_id: patientId, medications: perMed };
  }

  // ─── Encounter Detail ─────────────────────────────────────────────────────

  async getEncounterDetail(encounterId: string): Promise<Record<string, unknown>> {
    const encRows = await this.query(
      `MATCH (e:Encounter {encounter_id: $eid})
       OPTIONAL MATCH (p:Patient)-[:HAD_ENCOUNTER]->(e)
       OPTIONAL MATCH (e)-[:TREATED_BY]->(prov:Provider)
       OPTIONAL MATCH (e)-[:AT_ORGANIZATION]->(org:Organization)
       RETURN e.encounter_class AS class, e.description AS description,
              e.start_date AS start_date, e.stop_date AS stop_date,
              e.reason_code AS reason_code, e.reason_description AS reason_description,
              p.patient_id AS patient_id, p.first_name AS first_name, p.last_name AS last_name,
              prov.name AS provider_name, prov.specialty AS provider_specialty,
              org.name AS organization_name`,
      { eid: encounterId },
    );
    if (encRows.length === 0) return { error: `Encounter ${encounterId} not found` };
    const enc = encRows[0];

    const [conditions, medications, labs, procedures] = await Promise.all([
      this.query(
        `MATCH (:Patient)-[r:DIAGNOSED_WITH {encounter_id: $eid}]->(c:ConceptCondition)
         RETURN c.code AS code, c.description AS description, r.start_date AS start_date`,
        { eid: encounterId },
      ),
      this.query(
        `MATCH (:Patient)-[r:PRESCRIBED {encounter_id: $eid}]->(m:ConceptMedication)
         RETURN m.code AS code, m.description AS description,
                r.start_date AS start_date, r.stop_date AS stop_date,
                r.reason_description AS reason`,
        { eid: encounterId },
      ),
      this.query(
        `MATCH (:Patient)-[r:HAS_RESULT {encounter_id: $eid}]->(o:ConceptObservation)
         RETURN o.code AS code, o.description AS description,
                r.value AS value, r.units AS units, r.value_canonical AS value_canonical,
                r.units_canonical AS units_canonical, r.date AS date`,
        { eid: encounterId },
      ),
      this.query(
        `MATCH (:Patient)-[r:UNDERWENT {encounter_id: $eid}]->(pr:ConceptProcedure)
         RETURN pr.code AS code, pr.description AS description,
                r.start_date AS start_date, r.stop_date AS stop_date,
                r.reason_description AS reason`,
        { eid: encounterId },
      ),
    ]);

    return {
      encounter_id: encounterId,
      class: enc.class,
      description: enc.description,
      start_date: enc.start_date,
      stop_date: enc.stop_date,
      reason: enc.reason_description,
      patient: enc.patient_id
        ? { patient_id: enc.patient_id, name: `${enc.first_name} ${enc.last_name}` }
        : null,
      provider: enc.provider_name
        ? { name: enc.provider_name, specialty: enc.provider_specialty }
        : null,
      organization: enc.organization_name ?? null,
      conditions,
      medications,
      labs,
      procedures,
    };
  }

  // ─── List Treatments for Condition ────────────────────────────────────────

  async listTreatmentsForCondition(opts: {
    condition: string;
    limit?: number;
  }): Promise<Record<string, unknown>> {
    const { condition } = opts;
    const limit = Math.min(opts.limit ?? 20, 100);
    const byCode = /^\d{5,20}$/.test(condition.trim());
    const condFilter = byCode ? 'c.code = $condition' : 'LOWER(c.description) CONTAINS LOWER($condition)';

    const rows = await this.query(
      `MATCH (m:ConceptMedication)-[:TREATS]->(c:ConceptCondition)
       WHERE ${condFilter}
       MATCH (p:Patient)-[r:PRESCRIBED]->(m)
       WHERE r.reason_code = c.code
       RETURN m.code AS code, m.description AS description,
              c.code AS condition_code, c.description AS condition_description,
              count(DISTINCT p) AS patient_count,
              count(DISTINCT r.start_date) AS distinct_rx_dates
       ORDER BY patient_count DESC, distinct_rx_dates DESC
       LIMIT ${limit}`,
      { condition },
    );

    if (rows.length === 0) {
      return {
        condition_query: condition,
        note: `No TREATS edges found for condition '${condition}'`,
        medications: [],
      };
    }

    return {
      condition_query: condition,
      medications: rows.map((r) => ({
        code: r.code,
        description: r.description,
        condition_code: r.condition_code,
        condition_description: r.condition_description,
        patient_count: Number(r.patient_count),
        distinct_prescription_dates: Number(r.distinct_rx_dates),
      })),
    };
  }

  // ─── Patient Procedures ───────────────────────────────────────────────────

  async getPatientProcedures(patientId: string): Promise<ProcedureRecord[]> {
    const rows = await this.query(
      `MATCH (:Patient {patient_id: $id})-[r:UNDERWENT]->(pr:ConceptProcedure)
       RETURN pr.code AS code, pr.system AS system, pr.description AS description,
              r.start_date AS start_date, r.stop_date AS stop_date,
              r.reason_code AS reason_code, r.reason_description AS reason_description,
              r.encounter_id AS encounter_id
       ORDER BY r.start_date DESC`,
      { id: patientId },
    );
    return rows.map((r) => ({
      code: r.code as string,
      system: (r.system as string) ?? '',
      description: r.description as string,
      start_date: (r.start_date as string) ?? '',
      stop_date: (r.stop_date as string) ?? '',
      reason_code: (r.reason_code as string) ?? '',
      reason_description: (r.reason_description as string) ?? '',
      encounter_id: (r.encounter_id as string) ?? '',
    }));
  }

  // ─── Rank Conditions in Cohort ────────────────────────────────────────────

  async rankConditionsInCohort(opts: {
    conditions?: string[];
    medications?: string[];
    ageRange?: [number, number];
    gender?: string;
    includeFindings?: boolean;
    limit?: number;
  }): Promise<Array<{ description: string; code: string; patient_count: number }>> {
    const limit = Math.min(opts.limit ?? 10, 100);
    const matchClauses: string[] = ['MATCH (p:Patient)'];
    const filters: string[] = [];
    const params: Record<string, KuzuValue> = {};

    if (opts.conditions) {
      opts.conditions.forEach((cond, i) => {
        matchClauses.push(`MATCH (p)-[:DIAGNOSED_WITH]->(c${i}:ConceptCondition)`);
        filters.push(`LOWER(c${i}.description) CONTAINS LOWER($cond${i})`);
        params[`cond${i}`] = cond;
      });
    }
    if (opts.medications) {
      opts.medications.forEach((med, i) => {
        matchClauses.push(`MATCH (p)-[:PRESCRIBED]->(m${i}:ConceptMedication)`);
        filters.push(`LOWER(m${i}.description) CONTAINS LOWER($med${i})`);
        params[`med${i}`] = med;
      });
    }
    if (opts.gender) {
      filters.push('p.gender = $gender');
      params.gender = opts.gender;
    }

    // Findings filter is combined with the new MATCH, not the cohort WHERE,
    // because the ranking MATCH introduces its own c variable.
    const cohortWhere = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';
    const findingFilter = opts.includeFindings
      ? ''
      : (cohortWhere ? " AND NOT c.description ENDS WITH '(finding)'" : "WHERE NOT c.description ENDS WITH '(finding)'");

    const rows = await this.query(
      `${matchClauses.join('\n')}
       MATCH (p)-[:DIAGNOSED_WITH]->(c:ConceptCondition)
       ${cohortWhere}${findingFilter}
       RETURN c.description AS description, c.code AS code,
              count(DISTINCT p) AS patient_count
       ORDER BY patient_count DESC
       LIMIT ${limit}`,
      params,
    );
    return rows.map((r) => ({
      description: r.description as string,
      code: r.code as string,
      patient_count: Number(r.patient_count),
    }));
  }
}
