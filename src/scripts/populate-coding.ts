// ─── Populate: coding instance ──────────────────────────────────────────────
// Invoked by interactive `brainifai init` when the user opts in for the
// coding type's populate step. Reads instance context from env:
//   BRAINIFAI_INSTANCE_PATH, BRAINIFAI_DB_PATH, BRAINIFAI_INSTANCE_NAME
//
// Intended behavior (stub for now):
//   1. Run `gitnexus analyze` in the workdir so symbol context is fresh.
//   2. Seed the Kuzu DB from recent git log — each commit becomes a Memory
//      with kind='observation', linked to Entities extracted from paths.
//   3. Print a summary of what got loaded.

const instancePath = process.env.BRAINIFAI_INSTANCE_PATH;
const dbPath       = process.env.BRAINIFAI_DB_PATH;
const instanceName = process.env.BRAINIFAI_INSTANCE_NAME;

if (!instancePath || !dbPath || !instanceName) {
  console.error('populate-coding: missing BRAINIFAI_INSTANCE_PATH / BRAINIFAI_DB_PATH / BRAINIFAI_INSTANCE_NAME');
  process.exit(1);
}

console.log(`[populate-coding] instance=${instanceName}`);
console.log(`[populate-coding] dbPath=${dbPath}`);
console.log('[populate-coding] stub — no-op for now. Wire up gitnexus + git log ingestion here.');

process.exit(0);
