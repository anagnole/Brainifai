// ─── Populate: researcher instance ──────────────────────────────────────────
// Invoked by interactive `brainifai init` when the user opts in for the
// researcher type's populate step. Reads instance context from env.
//
// Intended behavior (stub):
//   1. Prompt user for a seed query describing the domain (e.g.
//      "cryptocurrency regulation 2026").
//   2. Fan out to Twitter / GitHub / Slack ingestion with that query.
//   3. Run LLM extraction on returned activities to populate entities,
//      events, and relationships.

const instancePath = process.env.BRAINIFAI_INSTANCE_PATH;
const dbPath       = process.env.BRAINIFAI_DB_PATH;
const instanceName = process.env.BRAINIFAI_INSTANCE_NAME;

if (!instancePath || !dbPath || !instanceName) {
  console.error('populate-researcher: missing BRAINIFAI_INSTANCE_PATH / BRAINIFAI_DB_PATH / BRAINIFAI_INSTANCE_NAME');
  process.exit(1);
}

console.log(`[populate-researcher] instance=${instanceName}`);
console.log(`[populate-researcher] dbPath=${dbPath}`);
console.log('[populate-researcher] stub — no-op for now. Wire up domain backfill here.');

process.exit(0);
