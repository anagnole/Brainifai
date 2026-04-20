// ─── Populate: project-manager instance ─────────────────────────────────────
// Invoked by interactive `brainifai init` when the user opts in for the
// project-manager type's populate step. Reads instance context from env.
//
// Intended behavior (stub):
//   1. Walk ~/Projects (configurable) to enumerate git repos.
//   2. For each repo, extract package.json / pyproject.toml / Cargo.toml
//      metadata, recent commit stats, and any .brainifai/ config.
//   3. Seed Project / Person / Tech nodes and cross-project dependency edges.

const instancePath = process.env.BRAINIFAI_INSTANCE_PATH;
const dbPath       = process.env.BRAINIFAI_DB_PATH;
const instanceName = process.env.BRAINIFAI_INSTANCE_NAME;

if (!instancePath || !dbPath || !instanceName) {
  console.error('populate-project-manager: missing BRAINIFAI_INSTANCE_PATH / BRAINIFAI_DB_PATH / BRAINIFAI_INSTANCE_NAME');
  process.exit(1);
}

console.log(`[populate-project-manager] instance=${instanceName}`);
console.log(`[populate-project-manager] dbPath=${dbPath}`);
console.log('[populate-project-manager] stub — no-op for now. Wire up portfolio scan here.');

process.exit(0);
