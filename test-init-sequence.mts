/**
 * Replicates the exact sequence of brainifai init --type project-manager:
 * 1. registerWithGlobal (opens global DB, closes it)
 * 2. runProjectManagerIngestion (opens fresh project DB)
 *
 * If this segfaults, the global DB open/close is poisoning something.
 * If this works, the bug is in projectsDir or the real init path.
 */
import kuzu from 'kuzu';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { runProjectManagerIngestion } from './src/ingestion/project-manager/index.js';

const GLOBAL_DB = resolve(homedir(), '.brainifai', 'data', 'kuzu');
const PROJECT_DB = '/tmp/test-pm-init-kuzu';

// Clean slate
if (existsSync(PROJECT_DB)) rmSync(PROJECT_DB, { recursive: true });

// ── Step 1: Simulate registerWithGlobal (open global DB write, close) ──────
console.log('Step 1: Opening global DB (write mode)...');
const db = new kuzu.Database(GLOBAL_DB, 0, true, false);
const conn = new kuzu.Connection(db);
await conn.query('MATCH (n:Instance) RETURN n.name LIMIT 1').catch(() => {});
await conn.close();
await db.close();
console.log('Step 1: Global DB closed.');

// ── Step 2: Run ingestion on fresh project DB ───────────────────────────────
console.log('Step 2: Running ingestion on fresh project DB...');
const stats = await runProjectManagerIngestion({
  dbPath: PROJECT_DB,
  projectsDir: '/Users/anagnole/Projects',
  verbose: true,
  force: false,
});
console.log('Step 2: Done.', JSON.stringify(stats));
process.exit(0);
