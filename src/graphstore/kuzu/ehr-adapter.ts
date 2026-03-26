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
    if (params && Object.keys(params).length > 0) {
      const ps = await this.conn.prepare(cypher);
      const result = await this.conn.execute(ps, params);
      const qr = Array.isArray(result) ? result[0] : result;
      return qr.getAll();
    }
    const result = await this.conn.query(cypher);
    const qr = Array.isArray(result) ? result[0] : result;
    return qr.getAll();
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
         RETURN e.encounter_id AS encounter_id, e.encounter_class AS encounter_class,
                e.code AS code, e.description AS description,
                e.start_date AS start_date, e.stop_date AS stop_date,
                e.reason_code AS reason_code, e.reason_description AS reason_description,
                e.provider_id AS provider_id, e.organization_id AS organization_id`,
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
      filters.push("(r.stop_date IS NULL OR r.stop_date = '')");
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
    opts?: { status?: 'active' | 'resolved' },
  ): Promise<ConditionRecord[]> {
    const filters = ['p.patient_id = $id'];
    const params: Record<string, KuzuValue> = { id: patientId };

    if (opts?.status === 'active') {
      filters.push("(r.stop_date IS NULL OR r.stop_date = '')");
    } else if (opts?.status === 'resolved') {
      filters.push("r.stop_date IS NOT NULL AND r.stop_date <> ''");
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

    if (opts.conditions && opts.conditions.length > 0) {
      for (let i = 0; i < opts.conditions.length; i++) {
        matchClauses.push(`MATCH (p)-[:DIAGNOSED_WITH]->(c${i}:ConceptCondition)`);
        filters.push(`c${i}.description CONTAINS $cond${i}`);
        params[`cond${i}`] = opts.conditions[i];
      }
    }

    if (opts.medications && opts.medications.length > 0) {
      for (let i = 0; i < opts.medications.length; i++) {
        matchClauses.push(`MATCH (p)-[:PRESCRIBED]->(m${i}:ConceptMedication)`);
        filters.push(`m${i}.description CONTAINS $med${i}`);
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
}
