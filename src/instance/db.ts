import kuzu from 'kuzu';
import { existsSync, mkdirSync } from 'node:fs';
import { KuzuGraphStore } from '../graphstore/kuzu/adapter.js';
import { createEhrSchema } from '../graphstore/kuzu/ehr-schema.js';

/** Initialize a fresh Kuzu DB with the standard schema at the given path */
export async function initializeInstanceDb(dbPath: string, type?: string): Promise<void> {
  if (type === 'ehr') {
    return initializeEhrDb(dbPath);
  }
  const store = new KuzuGraphStore({ dbPath, readOnly: false });
  await store.initialize();
  await store.close();
}

/** Initialize an EHR-specific Kuzu DB (separate schema, no base tables) */
async function initializeEhrDb(dbPath: string): Promise<void> {
  // Ensure parent directory exists, but let Kuzu create its own DB directory
  const parentDir = dbPath.replace(/[/\\][^/\\]+$/, '');
  if (parentDir && !existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  await conn.query('LOAD EXTENSION fts');
  await createEhrSchema(conn);
  // Skip FTS creation — indexes must be built AFTER data load
  // (Kuzu FTS is immutable; creating on empty tables is wasteful)
  await conn.close();
  await db.close();
}
