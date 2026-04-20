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
  description: 'Get conditions/diagnoses for a patient, optionally filtered by active or resolved status',
  schema: {
    patient_id: z.string().describe('The patient ID'),
    status: z.enum(['active', 'resolved']).optional()
      .describe('Filter by condition status: active (no stop date) or resolved (has stop date)'),
  },
  async execute(input) {
    const { patient_id, status } = input as { patient_id: string; status?: 'active' | 'resolved' };
    return withEhrStore(async (store) => {
      const conditions = await store.getPatientConditions(patient_id, { status });
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
