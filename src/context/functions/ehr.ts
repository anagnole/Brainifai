/**
 * EHR context functions — 7 clinical query tools for the EHR instance type.
 *
 * Uses shared concept node model. Clinical data on relationship properties.
 */

import { z } from 'zod';
import type { ContextFunction } from '../types.js';
import { EhrGraphStore } from '../../graphstore/kuzu/ehr-adapter.js';
import { resolveInstanceDbPath } from '../../instance/resolve.js';

async function withEhrStore<T>(fn: (store: EhrGraphStore) => Promise<T>): Promise<T> {
  const dbPath = resolveInstanceDbPath();
  const store = new EhrGraphStore({ dbPath, readOnly: true });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

// ─── 1. search_patients ───────────────────────────────────────────────────────

export const searchPatientsFn: ContextFunction = {
  name: 'search_patients',
  description: 'Search for patients by name or city using full-text search',
  schema: {
    query: z.string().describe('Search text (patient name, city, etc.)'),
    limit: z.number().int().min(1).max(50).default(20)
      .describe('Maximum results to return'),
  },
  async execute(input) {
    const { query, limit } = input as { query: string; limit?: number };
    return withEhrStore(async (store) => {
      const patients = await store.searchPatients(query, limit ?? 20);
      return {
        patients,
        record_ids: patients.map((p) => p.patient_id),
      };
    });
  },
};

// ─── 2. get_patient_summary ───────────────────────────────────────────────────

export const patientSummaryFn: ContextFunction = {
  name: 'get_patient_summary',
  description: 'Get a complete clinical summary for a patient: demographics, conditions, medications, labs, procedures, and encounters',
  schema: {
    patient_id: z.string().describe('The patient ID to look up'),
  },
  async execute(input) {
    const { patient_id } = input as { patient_id: string };
    return withEhrStore(async (store) => {
      const summary = await store.getPatientSummary(patient_id);
      if (!summary) return { error: `Patient ${patient_id} not found` };
      return {
        ...summary,
        record_ids: [
          summary.patient.patient_id,
          ...summary.conditions.map((c) => c.code),
          ...summary.medications.map((m) => m.code),
          ...summary.observations.map((o) => o.code),
          ...summary.procedures.map((p) => p.code),
          ...summary.encounters.map((e) => e.encounter_id),
        ],
      };
    });
  },
};

// ─── 3. get_medications ───────────────────────────────────────────────────────

export const medicationsFn: ContextFunction = {
  name: 'get_medications',
  description: 'Get medications for a patient, optionally filtered by active status or medication name',
  schema: {
    patient_id: z.string().describe('The patient ID'),
    active: z.boolean().optional().describe('If true, only return active (no stop date) medications'),
    name: z.string().optional().describe('Filter by medication name (partial match)'),
  },
  async execute(input) {
    const { patient_id, active, name } = input as { patient_id: string; active?: boolean; name?: string };
    return withEhrStore(async (store) => {
      const medications = await store.getPatientMedications(patient_id, { active, name });
      return {
        patient_id,
        medications,
        record_ids: medications.map((m) => m.code),
      };
    });
  },
};

// ─── 4. get_diagnoses ─────────────────────────────────────────────────────────

export const diagnosesFn: ContextFunction = {
  name: 'get_diagnoses',
  description: "Get medical conditions/diagnoses for a patient. By default excludes SNOMED '(finding)' entries (e.g. social determinants like 'Full-time employment', 'Educated to high school level') which Synthea co-mingles with clinical diagnoses — set include_findings=true to include them.",
  schema: {
    patient_id: z.string().describe('The patient ID'),
    status: z.enum(['active', 'resolved']).optional()
      .describe('Filter by condition status: active (no stop date) or resolved (has stop date)'),
    include_findings: z.boolean().optional()
      .describe("Include SNOMED '(finding)' entries (SDoH, education, employment). Default false."),
  },
  async execute(input) {
    const { patient_id, status, include_findings } = input as {
      patient_id: string;
      status?: 'active' | 'resolved';
      include_findings?: boolean;
    };
    return withEhrStore(async (store) => {
      const conditions = await store.getPatientConditions(patient_id, {
        status,
        includeFindings: include_findings,
      });
      return {
        patient_id,
        conditions,
        record_ids: conditions.map((c) => c.code),
      };
    });
  },
};

// ─── 5. get_labs ──────────────────────────────────────────────────────────────

export const labsFn: ContextFunction = {
  name: 'get_labs',
  description: 'Get lab results (observations) for a patient, optionally filtered by LOINC code or date range',
  schema: {
    patient_id: z.string().describe('The patient ID'),
    code: z.string().optional().describe('LOINC code to filter by (e.g., "4548-4" for HbA1c)'),
    start_date: z.string().optional().describe('Start date filter (YYYY-MM-DD)'),
    end_date: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
  },
  async execute(input) {
    const { patient_id, code, start_date, end_date } = input as {
      patient_id: string; code?: string; start_date?: string; end_date?: string;
    };
    return withEhrStore(async (store) => {
      const labs = await store.getPatientLabs(patient_id, {
        code, startDate: start_date, endDate: end_date,
      });
      return {
        patient_id,
        labs,
        record_ids: labs.map((l) => l.code),
      };
    });
  },
};

// ─── 6. get_temporal_relation ─────────────────────────────────────────────────

export const temporalRelationFn: ContextFunction = {
  name: 'get_temporal_relation',
  description: 'Determine the temporal relationship between two clinical events for a patient (e.g., was a condition diagnosed before a medication was started?)',
  schema: {
    patient_id: z.string().describe('The patient ID'),
    from_type: z.enum(['condition', 'medication', 'observation', 'procedure', 'encounter'])
      .describe('Entity type of the first event'),
    from_id: z.string().describe('Entity ID of the first event'),
    to_type: z.enum(['condition', 'medication', 'observation', 'procedure', 'encounter'])
      .describe('Entity type of the second event'),
    to_id: z.string().describe('Entity ID of the second event'),
  },
  async execute(input) {
    const { patient_id, from_type, from_id, to_type, to_id } = input as {
      patient_id: string; from_type: string; from_id: string; to_type: string; to_id: string;
    };
    return withEhrStore(async (store) => {
      const result = await store.getTemporalRelation(patient_id, {
        fromType: from_type, fromId: from_id,
        toType: to_type, toId: to_id,
      });
      if (!result) return { error: 'Could not determine temporal relation — one or both events not found' };
      return {
        patient_id,
        ...result,
        record_ids: [from_id, to_id],
      };
    });
  },
};

// ─── 10. count_cohort ─────────────────────────────────────────────────────────

export const countCohortFn: ContextFunction = {
  name: 'count_cohort',
  description: 'Count distinct patients matching criteria (conditions, medications, age, gender). Returns ONLY a number — use this for "how many patients have X" questions instead of find_cohort, which is capped at 100 and returns a heavy patient-record payload. Condition/medication matching is case-insensitive and substring-based, matching the question generator semantics.',
  schema: {
    conditions: z.array(z.string()).optional()
      .describe('Condition description substrings (case-insensitive; all must be present per patient)'),
    medications: z.array(z.string()).optional()
      .describe('Medication description substrings (case-insensitive; all must be present per patient)'),
    age_min: z.number().int().optional().describe('Minimum age in years'),
    age_max: z.number().int().optional().describe('Maximum age in years'),
    gender: z.string().optional().describe('Gender filter (M or F)'),
  },
  async execute(input) {
    const { conditions, medications, age_min, age_max, gender } = input as {
      conditions?: string[]; medications?: string[];
      age_min?: number; age_max?: number; gender?: string;
    };
    const ageRange = (age_min !== undefined && age_max !== undefined)
      ? [age_min, age_max] as [number, number]
      : undefined;
    return withEhrStore(async (store) => {
      const count = await store.countCohort({ conditions, medications, ageRange, gender });
      return { count, record_ids: [] };
    });
  },
};

// ─── 8. find_observation_concepts ─────────────────────────────────────────────

export const findObservationConceptsFn: ContextFunction = {
  name: 'find_observation_concepts',
  description: 'Search for observation/lab concept nodes by clinical name. Returns matching LOINC codes with their official descriptions and units. ALWAYS call this first when a question mentions a lab by its common name (e.g. "Total Cholesterol", "HbA1c", "BP") — Synthea uses LOINC\'s verbose descriptions ("Cholesterol [Mass/volume] in Serum or Plasma"), not clinical shorthand, so a literal description match will usually miss.',
  schema: {
    query: z.string().describe('Clinical name to search for, e.g. "cholesterol", "hemoglobin", "glucose"'),
    limit: z.number().int().min(1).max(50).default(10).describe('Maximum results to return'),
  },
  async execute(input) {
    const { query, limit } = input as { query: string; limit?: number };
    return withEhrStore(async (store) => {
      const concepts = await store.findObservationConcepts(query, limit ?? 10);
      return {
        concepts,
        record_ids: concepts.map((c) => c.code),
      };
    });
  },
};

// ─── 9. aggregate_observation_for_cohort ──────────────────────────────────────

export const aggregateObservationForCohortFn: ContextFunction = {
  name: 'aggregate_observation_for_cohort',
  description: 'Compute an aggregate statistic (avg/min/max/sum/count/median) of the most-recent observation value across a cohort of patients matching a condition. ALWAYS use this for cohort aggregation questions like "what is the average X for patients with Y" — do NOT loop get_labs per patient, that hits the context limit and is much slower.',
  schema: {
    condition: z.string().describe('Condition description filter (partial match), e.g. "Hyperlipidemia"'),
    observation: z.string().optional().describe('Observation description filter (partial match), e.g. "Total Cholesterol". Required unless observation_code is given.'),
    observation_code: z.string().optional().describe('Optional exact LOINC code (e.g. "2093-3") — preferred over description filter when known. Use find_observation_concepts to discover the right code.'),
    aggregation: z.enum(['avg', 'min', 'max', 'sum', 'count', 'median']).describe('Aggregation function to apply across per-patient most-recent values'),
  },
  async execute(input) {
    const { condition, observation, observation_code, aggregation } = input as {
      condition: string;
      observation?: string;
      observation_code?: string;
      aggregation: 'avg' | 'min' | 'max' | 'sum' | 'count' | 'median';
    };
    if (!observation && !observation_code) {
      return { error: "Either 'observation' or 'observation_code' is required" };
    }
    return withEhrStore(async (store) => {
      const result = await store.aggregateObservationForCohort({
        condition,
        observationCode: observation_code,
        observationDescription: observation,
        aggregation,
      });
      return {
        ...result,
        record_ids: observation_code ? [observation_code] : [],
      };
    });
  },
};

// ─── 7. find_cohort ───────────────────────────────────────────────────────────

export const findCohortFn: ContextFunction = {
  name: 'find_cohort',
  description: 'Find patients matching criteria: conditions, medications, age range, and/or gender. Returns up to 100 matching patients.',
  schema: {
    conditions: z.array(z.string()).optional()
      .describe('Condition descriptions to match (partial match, all must be present)'),
    medications: z.array(z.string()).optional()
      .describe('Medication descriptions to match (partial match, all must be present)'),
    age_min: z.number().int().optional().describe('Minimum age in years'),
    age_max: z.number().int().optional().describe('Maximum age in years'),
    gender: z.string().optional().describe('Gender filter (M or F)'),
  },
  async execute(input) {
    const { conditions, medications, age_min, age_max, gender } = input as {
      conditions?: string[]; medications?: string[];
      age_min?: number; age_max?: number; gender?: string;
    };
    const ageRange = (age_min !== undefined && age_max !== undefined)
      ? [age_min, age_max] as [number, number]
      : undefined;
    return withEhrStore(async (store) => {
      const patients = await store.findCohort({ conditions, medications, ageRange, gender });
      return {
        patients,
        count: patients.length,
        record_ids: patients.map((p) => p.patient_id),
      };
    });
  },
};

// ─── 11. get_patient_age ──────────────────────────────────────────────────────

export const patientAgeFn: ContextFunction = {
  name: 'get_patient_age',
  description: "Compute a patient's age in years, server-side. Use this instead of computing age from birth_date — avoids off-by-one errors around birthdays and leap years. Example: {patient_id: 'abc-123'} returns current age; {patient_id, as_of: '2020-06-01'} returns age on that date. If the patient died before as_of, returns age at death.",
  schema: {
    patient_id: z.string().describe('The patient ID'),
    as_of: z.string().optional().describe('Optional reference date (YYYY-MM-DD). Defaults to today.'),
  },
  async execute(input) {
    const { patient_id, as_of } = input as { patient_id: string; as_of?: string };
    return withEhrStore(async (store) => {
      const result = await store.getPatientAge(patient_id, as_of);
      if ('error' in result) return { error: result.error, record_ids: [] };
      return { ...result, record_ids: [patient_id] };
    });
  },
};

// ─── 12. compare_observations ────────────────────────────────────────────────

export const compareObservationsFn: ContextFunction = {
  name: 'compare_observations',
  description: "Compare two values of the same lab for a patient over time — returns both values, delta, direction (rising/falling/stable), and days between. Use this instead of calling get_labs and subtracting values yourself. By default compares earliest vs. most recent; pass date_a/date_b to pick values nearest specific dates. Example: {patient_id: 'abc', observation_code: '4548-4'}.",
  schema: {
    patient_id: z.string().describe('The patient ID'),
    observation_code: z.string().describe('LOINC code of the observation to compare'),
    date_a: z.string().optional().describe('Optional — pick value nearest this date. If omitted, uses earliest.'),
    date_b: z.string().optional().describe('Optional — pick value nearest this date. If omitted, uses most recent.'),
  },
  async execute(input) {
    const { patient_id, observation_code, date_a, date_b } = input as {
      patient_id: string; observation_code: string; date_a?: string; date_b?: string;
    };
    return withEhrStore(async (store) => {
      const result = await store.compareObservations({
        patientId: patient_id,
        observationCode: observation_code,
        dateA: date_a,
        dateB: date_b,
      });
      return { ...result, record_ids: [observation_code] };
    });
  },
};

// ─── 13. cohort_observation_distribution ─────────────────────────────────────

export const cohortObservationDistributionFn: ContextFunction = {
  name: 'cohort_observation_distribution',
  description: "Return the DISTRIBUTION of an observation (histogram + counts in each bucket) across a cohort of patients matching a condition. Use this for spread/tails/threshold questions: 'how many diabetics have A1c > 9?', 'what fraction of hyperlipidemia patients have cholesterol in 200-240?'. Do NOT use for a single aggregate — use aggregate_observation_for_cohort for avg/min/max/median. Uses the most-recent value per patient. Example: {condition: 'diabetes', observation_code: '4548-4', thresholds: [7, 9]}.",
  schema: {
    condition: z.string().describe('Condition filter (partial match)'),
    observation: z.string().optional().describe('Observation description filter. Required unless observation_code is given.'),
    observation_code: z.string().optional().describe('Exact LOINC code (preferred)'),
    thresholds: z.array(z.number()).optional().describe('Bucket boundaries ascending. [7,9] → 3 buckets: (-inf,7], (7,9], (9,+inf). If omitted, 5 equal-width buckets.'),
  },
  async execute(input) {
    const { condition, observation, observation_code, thresholds } = input as {
      condition: string; observation?: string; observation_code?: string; thresholds?: number[];
    };
    if (!observation && !observation_code) {
      return { error: "Either 'observation' or 'observation_code' is required" };
    }
    return withEhrStore(async (store) => {
      const result = await store.cohortObservationDistribution({
        condition,
        observationCode: observation_code,
        observationDescription: observation,
        thresholds,
      });
      return { ...result, record_ids: observation_code ? [observation_code] : [] };
    });
  },
};

// ─── 14. get_medication_adherence ────────────────────────────────────────────

export const medicationAdherenceFn: ContextFunction = {
  name: 'get_medication_adherence',
  description: "Compute medication adherence metrics for a patient + medication: total days covered, gap days between fills, days-covered ratio, and a coarse adherence flag (adherent/partial/poor per WHO ≥80% MPR). Use this instead of fetching prescriptions and doing date math yourself. Example: {patient_id: 'abc', medication_code: '860975'}. Pass medication_name for partial description match when no code is known.",
  schema: {
    patient_id: z.string().describe('The patient ID'),
    medication_code: z.string().optional().describe('Exact RxNorm code — preferred'),
    medication_name: z.string().optional().describe('Partial description match used if code is not given'),
  },
  async execute(input) {
    const { patient_id, medication_code, medication_name } = input as {
      patient_id: string; medication_code?: string; medication_name?: string;
    };
    if (!medication_code && !medication_name) {
      return { error: 'Either medication_code or medication_name is required' };
    }
    return withEhrStore(async (store) => {
      const result = await store.getMedicationAdherence({
        patientId: patient_id,
        medicationCode: medication_code,
        medicationName: medication_name,
      });
      return { ...result, record_ids: [patient_id] };
    });
  },
};

// ─── 15. get_encounter_detail ────────────────────────────────────────────────

export const encounterDetailFn: ContextFunction = {
  name: 'get_encounter_detail',
  description: "Fetch one encounter with everything that happened at it: conditions diagnosed, medications prescribed, labs drawn, procedures performed (all joined via encounter_id on the relationship edges). Use for 'what happened at the visit on X date?' questions. To locate the encounter_id first, call get_patient_summary and inspect the recent encounters.",
  schema: {
    encounter_id: z.string().describe('The encounter_id (not patient_id) — the specific visit to describe'),
  },
  async execute(input) {
    const { encounter_id } = input as { encounter_id: string };
    return withEhrStore(async (store) => {
      const result = await store.getEncounterDetail(encounter_id);
      return { ...result, record_ids: [encounter_id] };
    });
  },
};

// ─── 16. list_treatments_for_condition ───────────────────────────────────────

export const listTreatmentsForConditionFn: ContextFunction = {
  name: 'list_treatments_for_condition',
  description: "List medications typically prescribed for a given condition across the cohort. Uses the ConceptMedication-[TREATS]->ConceptCondition edge plus actual prescription volume, ranked by distinct patient count. Answers 'what's typically used to treat X?' questions at graph speed — no cohort scan. Example: {condition: 'diabetes mellitus type 2'} returns metformin, insulin, etc.",
  schema: {
    condition: z.string().describe('Condition description (partial match) or exact SNOMED code'),
    limit: z.number().int().min(1).max(100).default(20).describe('Maximum medications to return'),
  },
  async execute(input) {
    const { condition, limit } = input as { condition: string; limit?: number };
    return withEhrStore(async (store) => {
      const result = await store.listTreatmentsForCondition({ condition, limit });
      const meds = (result as { medications?: Array<{ code: string }> }).medications ?? [];
      return { ...result, record_ids: meds.map((m) => m.code) };
    });
  },
};

// ─── 17. get_procedures ──────────────────────────────────────────────────────

export const proceduresFn: ContextFunction = {
  name: 'get_procedures',
  description: 'Get procedures performed on a patient (SNOMED codes). Returns start/stop date, reason, and encounter ID for each.',
  schema: {
    patient_id: z.string().describe('The patient ID'),
  },
  async execute(input) {
    const { patient_id } = input as { patient_id: string };
    return withEhrStore(async (store) => {
      const procedures = await store.getPatientProcedures(patient_id);
      return { patient_id, procedures, record_ids: procedures.map((p) => p.code) };
    });
  },
};

// ─── 18. rank_conditions_in_cohort ───────────────────────────────────────────

export const rankConditionsInCohortFn: ContextFunction = {
  name: 'rank_conditions_in_cohort',
  description: "Rank the most common diagnoses among a cohort of patients matching criteria. Returns conditions ordered by distinct patient count, excluding SNOMED '(finding)' SDoH entries by default. Use for 'most common conditions in patients with X' questions. Example: {conditions: ['diabetes']} ranks conditions most often co-occurring with diabetes in the cohort.",
  schema: {
    conditions: z.array(z.string()).optional().describe('Cohort-defining conditions'),
    medications: z.array(z.string()).optional().describe('Cohort-defining medications'),
    age_min: z.number().int().optional(),
    age_max: z.number().int().optional(),
    gender: z.string().optional().describe("'M' or 'F'"),
    include_findings: z.boolean().optional().describe("Include SNOMED '(finding)' SDoH entries. Default false."),
    limit: z.number().int().min(1).max(100).default(10),
  },
  async execute(input) {
    const { conditions, medications, age_min, age_max, gender, include_findings, limit } = input as {
      conditions?: string[]; medications?: string[]; age_min?: number; age_max?: number;
      gender?: string; include_findings?: boolean; limit?: number;
    };
    const ageRange = (age_min !== undefined && age_max !== undefined)
      ? [age_min, age_max] as [number, number]
      : undefined;
    return withEhrStore(async (store) => {
      const rows = await store.rankConditionsInCohort({
        conditions, medications, ageRange, gender,
        includeFindings: include_findings, limit,
      });
      return { conditions: rows, record_ids: rows.map((r) => r.code) };
    });
  },
};
