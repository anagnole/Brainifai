// ─── Populate: ehr instance ─────────────────────────────────────────────────
// Invoked by interactive `brainifai init` when the user opts in for the
// ehr type's populate step. Reads instance context from env.
//
// Intended behavior (stub):
//   1. Locate Synthea FHIR bundles (env var or user prompt).
//   2. Parse bundles and upsert Patient / Encounter / Condition / Medication /
//      Observation / Procedure / Provider nodes + their relationships.
//   3. Build FTS indexes for fast clinical search.

const instancePath = process.env.BRAINIFAI_INSTANCE_PATH;
const dbPath       = process.env.BRAINIFAI_DB_PATH;
const instanceName = process.env.BRAINIFAI_INSTANCE_NAME;

if (!instancePath || !dbPath || !instanceName) {
  console.error('populate-ehr: missing BRAINIFAI_INSTANCE_PATH / BRAINIFAI_DB_PATH / BRAINIFAI_INSTANCE_NAME');
  process.exit(1);
}

console.log(`[populate-ehr] instance=${instanceName}`);
console.log(`[populate-ehr] dbPath=${dbPath}`);
console.log('[populate-ehr] stub — no-op for now. Wire up Synthea bundle loading here.');

process.exit(0);
