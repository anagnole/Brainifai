/**
 * EHR Schema + EhrGraphStore integration tests.
 *
 * Runs against an in-memory Kuzu DB with the EHR schema.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EhrGraphStore } from './ehr-adapter.js';

describe('EHR Schema & Adapter', () => {
  let store: EhrGraphStore;

  beforeAll(async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ehr-test-'));
    const dbPath = join(tmpDir, 'test.db');
    store = new EhrGraphStore({ dbPath });
    await store.initialize();

    // Seed test data — use the private query method via the store's connection
    // We'll use a helper approach: close and reopen to seed via raw kuzu
    await store.close();

    // Reopen with raw kuzu to seed
    const kuzu = await import('kuzu');
    const db = new kuzu.default.Database(dbPath);
    const conn = new kuzu.default.Connection(db);

    // Organizations
    await conn.query(`CREATE (o:Organization {
      organization_id: 'org-1', name: 'General Hospital', city: 'Boston',
      state: 'MA', zip: '02101', phone: '555-0100'
    })`);

    // Providers
    await conn.query(`CREATE (p:Provider {
      provider_id: 'prov-1', organization_id: 'org-1', name: 'Dr. Smith',
      gender: 'F', specialty: 'General Practice'
    })`);

    // Patients
    await conn.query(`CREATE (p:Patient {
      patient_id: 'P001', first_name: 'John', last_name: 'Doe',
      birth_date: '1980-01-15', death_date: '', gender: 'M',
      race: 'white', ethnicity: 'nonhispanic', marital_status: 'M',
      city: 'Boston', state: 'MA', zip: '02101'
    })`);
    await conn.query(`CREATE (p:Patient {
      patient_id: 'P002', first_name: 'Jane', last_name: 'Smith',
      birth_date: '1975-06-20', death_date: '', gender: 'F',
      race: 'white', ethnicity: 'nonhispanic', marital_status: 'S',
      city: 'Cambridge', state: 'MA', zip: '02139'
    })`);

    // Encounters
    await conn.query(`CREATE (e:Encounter {
      encounter_id: 'E001', patient_id: 'P001', provider_id: 'prov-1',
      organization_id: 'org-1', encounter_class: 'ambulatory', code: '185349003',
      description: 'Encounter for problem', start_date: '2023-01-10',
      stop_date: '2023-01-10', reason_code: '', reason_description: ''
    })`);
    await conn.query(`CREATE (e:Encounter {
      encounter_id: 'E002', patient_id: 'P001', provider_id: 'prov-1',
      organization_id: 'org-1', encounter_class: 'ambulatory', code: '185349003',
      description: 'Encounter for symptom', start_date: '2023-03-15',
      stop_date: '2023-03-15', reason_code: '', reason_description: ''
    })`);

    // Conditions
    await conn.query(`CREATE (c:Condition {
      condition_id: 'C001', patient_id: 'P001', encounter_id: 'E001',
      code: '44054006', system: 'SNOMED-CT', description: 'Diabetes mellitus type 2',
      start_date: '2023-01-10', stop_date: ''
    })`);
    await conn.query(`CREATE (c:Condition {
      condition_id: 'C002', patient_id: 'P001', encounter_id: 'E002',
      code: '38341003', system: 'SNOMED-CT', description: 'Hypertension',
      start_date: '2023-03-15', stop_date: '2023-06-01'
    })`);
    await conn.query(`CREATE (c:Condition {
      condition_id: 'C003', patient_id: 'P002', encounter_id: 'E001',
      code: '44054006', system: 'SNOMED-CT', description: 'Diabetes mellitus type 2',
      start_date: '2023-02-01', stop_date: ''
    })`);

    // Medications
    await conn.query(`CREATE (m:Medication {
      medication_id: 'M001', patient_id: 'P001', encounter_id: 'E001',
      code: '860975', description: 'Metformin 500 MG', start_date: '2023-01-10',
      stop_date: '', reason_code: '44054006', reason_description: 'Diabetes mellitus type 2'
    })`);

    // Observations
    await conn.query(`CREATE (o:Observation {
      observation_id: 'O001', patient_id: 'P001', encounter_id: 'E001',
      category: 'laboratory', code: '4548-4', description: 'Hemoglobin A1c',
      value: '7.2', units: '%', type: 'numeric', date: '2023-01-10'
    })`);
    await conn.query(`CREATE (o:Observation {
      observation_id: 'O002', patient_id: 'P001', encounter_id: 'E002',
      category: 'laboratory', code: '4548-4', description: 'Hemoglobin A1c',
      value: '6.8', units: '%', type: 'numeric', date: '2023-03-15'
    })`);

    // Procedures
    await conn.query(`CREATE (pr:Procedure {
      procedure_id: 'PR001', patient_id: 'P001', encounter_id: 'E001',
      code: '430193006', system: 'SNOMED-CT', description: 'Medication reconciliation',
      start_date: '2023-01-10', stop_date: '2023-01-10',
      reason_code: '', reason_description: ''
    })`);

    // Relationships
    // Patient → Encounter
    await conn.query(`MATCH (p:Patient {patient_id: 'P001'}), (e:Encounter {encounter_id: 'E001'}) CREATE (p)-[:HAS_ENCOUNTER]->(e)`);
    await conn.query(`MATCH (p:Patient {patient_id: 'P001'}), (e:Encounter {encounter_id: 'E002'}) CREATE (p)-[:HAS_ENCOUNTER]->(e)`);
    // Patient → Condition
    await conn.query(`MATCH (p:Patient {patient_id: 'P001'}), (c:Condition {condition_id: 'C001'}) CREATE (p)-[:HAS_CONDITION]->(c)`);
    await conn.query(`MATCH (p:Patient {patient_id: 'P001'}), (c:Condition {condition_id: 'C002'}) CREATE (p)-[:HAS_CONDITION]->(c)`);
    await conn.query(`MATCH (p:Patient {patient_id: 'P002'}), (c:Condition {condition_id: 'C003'}) CREATE (p)-[:HAS_CONDITION]->(c)`);
    // Patient → Medication
    await conn.query(`MATCH (p:Patient {patient_id: 'P001'}), (m:Medication {medication_id: 'M001'}) CREATE (p)-[:HAS_MEDICATION]->(m)`);
    // Patient → Observation
    await conn.query(`MATCH (p:Patient {patient_id: 'P001'}), (o:Observation {observation_id: 'O001'}) CREATE (p)-[:HAS_OBSERVATION]->(o)`);
    await conn.query(`MATCH (p:Patient {patient_id: 'P001'}), (o:Observation {observation_id: 'O002'}) CREATE (p)-[:HAS_OBSERVATION]->(o)`);
    // Patient → Procedure
    await conn.query(`MATCH (p:Patient {patient_id: 'P001'}), (pr:Procedure {procedure_id: 'PR001'}) CREATE (p)-[:HAS_PROCEDURE]->(pr)`);
    // Encounter → entities
    await conn.query(`MATCH (e:Encounter {encounter_id: 'E001'}), (c:Condition {condition_id: 'C001'}) CREATE (e)-[:ENCOUNTER_DIAGNOSIS]->(c)`);
    await conn.query(`MATCH (e:Encounter {encounter_id: 'E002'}), (c:Condition {condition_id: 'C002'}) CREATE (e)-[:ENCOUNTER_DIAGNOSIS]->(c)`);
    await conn.query(`MATCH (e:Encounter {encounter_id: 'E001'}), (m:Medication {medication_id: 'M001'}) CREATE (e)-[:ENCOUNTER_MEDICATION]->(m)`);
    await conn.query(`MATCH (e:Encounter {encounter_id: 'E001'}), (o:Observation {observation_id: 'O001'}) CREATE (e)-[:ENCOUNTER_OBSERVATION]->(o)`);
    await conn.query(`MATCH (e:Encounter {encounter_id: 'E002'}), (o:Observation {observation_id: 'O002'}) CREATE (e)-[:ENCOUNTER_OBSERVATION]->(o)`);
    await conn.query(`MATCH (e:Encounter {encounter_id: 'E001'}), (pr:Procedure {procedure_id: 'PR001'}) CREATE (e)-[:ENCOUNTER_PROCEDURE]->(pr)`);
    // Provider relationships
    await conn.query(`MATCH (e:Encounter {encounter_id: 'E001'}), (prov:Provider {provider_id: 'prov-1'}) CREATE (e)-[:TREATED_BY]->(prov)`);
    await conn.query(`MATCH (e:Encounter {encounter_id: 'E002'}), (prov:Provider {provider_id: 'prov-1'}) CREATE (e)-[:TREATED_BY]->(prov)`);
    await conn.query(`MATCH (prov:Provider {provider_id: 'prov-1'}), (org:Organization {organization_id: 'org-1'}) CREATE (prov)-[:AFFILIATED_WITH]->(org)`);
    await conn.query(`MATCH (e:Encounter {encounter_id: 'E001'}), (org:Organization {organization_id: 'org-1'}) CREATE (e)-[:AT_ORGANIZATION]->(org)`);

    await conn.close();
    await db.close();

    // Reopen via EhrGraphStore (read-only for queries)
    store = new EhrGraphStore({ dbPath });
    await store.initialize();
    await store.rebuildFtsIndexes();
  }, 30_000);

  afterAll(async () => {
    await store.close();
  });

  // ── Schema tests ──────────────────────────────────────────────────────

  it('patient summary returns full patient data', async () => {
    const summary = await store.getPatientSummary('P001');
    expect(summary).not.toBeNull();
    expect(summary!.patient.patient_id).toBe('P001');
    expect(summary!.patient.first_name).toBe('John');
    expect(summary!.patient.last_name).toBe('Doe');
    expect(summary!.conditions.length).toBe(2);
    expect(summary!.medications.length).toBe(1);
    expect(summary!.observations.length).toBe(2);
    expect(summary!.procedures.length).toBe(1);
    expect(summary!.encounters.length).toBe(2);
  });

  it('patient summary returns null for missing patient', async () => {
    const summary = await store.getPatientSummary('NONEXISTENT');
    expect(summary).toBeNull();
  });

  it('getPatientConditions returns all conditions', async () => {
    const conditions = await store.getPatientConditions('P001');
    expect(conditions.length).toBe(2);
    expect(conditions.some((c) => c.description === 'Diabetes mellitus type 2')).toBe(true);
    expect(conditions.some((c) => c.description === 'Hypertension')).toBe(true);
  });

  it('getPatientConditions filters active conditions', async () => {
    const active = await store.getPatientConditions('P001', { status: 'active' });
    expect(active.length).toBe(1);
    expect(active[0].description).toBe('Diabetes mellitus type 2');
  });

  it('getPatientConditions filters resolved conditions', async () => {
    const resolved = await store.getPatientConditions('P001', { status: 'resolved' });
    expect(resolved.length).toBe(1);
    expect(resolved[0].description).toBe('Hypertension');
  });

  it('getPatientMedications returns medications', async () => {
    const meds = await store.getPatientMedications('P001');
    expect(meds.length).toBe(1);
    expect(meds[0].description).toBe('Metformin 500 MG');
  });

  it('getPatientMedications filters active medications', async () => {
    const active = await store.getPatientMedications('P001', { active: true });
    expect(active.length).toBe(1);
  });

  it('getPatientMedications filters by name', async () => {
    const meds = await store.getPatientMedications('P001', { name: 'Metformin' });
    expect(meds.length).toBe(1);

    const none = await store.getPatientMedications('P001', { name: 'Aspirin' });
    expect(none.length).toBe(0);
  });

  it('getPatientLabs returns observations', async () => {
    const labs = await store.getPatientLabs('P001');
    expect(labs.length).toBe(2);
  });

  it('getPatientLabs filters by code', async () => {
    const labs = await store.getPatientLabs('P001', { code: '4548-4' });
    expect(labs.length).toBe(2);

    const none = await store.getPatientLabs('P001', { code: 'NONEXISTENT' });
    expect(none.length).toBe(0);
  });

  it('getPatientLabs filters by date range', async () => {
    const labs = await store.getPatientLabs('P001', {
      startDate: '2023-02-01',
      endDate: '2023-12-31',
    });
    expect(labs.length).toBe(1);
    expect(labs[0].date).toBe('2023-03-15');
  });

  it('temporal relation: condition before medication gives same_day', async () => {
    // C001 (Diabetes, 2023-01-10) and M001 (Metformin, 2023-01-10) — same day
    const result = await store.getTemporalRelation('P001', {
      fromType: 'condition', fromId: 'C001',
      toType: 'medication', toId: 'M001',
    });
    expect(result).not.toBeNull();
    expect(result!.relation).toBe('same_day');
  });

  it('temporal relation: condition before later condition', async () => {
    // C001 (2023-01-10) before C002 (2023-03-15)
    const result = await store.getTemporalRelation('P001', {
      fromType: 'condition', fromId: 'C001',
      toType: 'condition', toId: 'C002',
    });
    expect(result).not.toBeNull();
    expect(result!.relation).toBe('before');
  });

  it('temporal relation returns null for unknown entity', async () => {
    const result = await store.getTemporalRelation('P001', {
      fromType: 'condition', fromId: 'NONEXISTENT',
      toType: 'medication', toId: 'M001',
    });
    expect(result).toBeNull();
  });

  it('findCohort: patients with diabetes', async () => {
    const cohort = await store.findCohort({ conditions: ['Diabetes'] });
    expect(cohort.length).toBe(2); // P001 and P002
    const ids = cohort.map((p) => p.patient_id).sort();
    expect(ids).toEqual(['P001', 'P002']);
  });

  it('findCohort: patients with diabetes AND hypertension', async () => {
    const cohort = await store.findCohort({
      conditions: ['Diabetes', 'Hypertension'],
    });
    expect(cohort.length).toBe(1);
    expect(cohort[0].patient_id).toBe('P001');
  });

  it('findCohort: filter by gender', async () => {
    const males = await store.findCohort({ gender: 'M' });
    expect(males.length).toBe(1);
    expect(males[0].patient_id).toBe('P001');
  });

  it('searchPatients via FTS', async () => {
    const results = await store.searchPatients('John');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].patient_id).toBe('P001');
  });

  it('searchPatients by city', async () => {
    const results = await store.searchPatients('Cambridge');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].patient_id).toBe('P002');
  });
});
