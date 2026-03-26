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
