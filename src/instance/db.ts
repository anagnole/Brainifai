import kuzu from 'kuzu';
import { existsSync, mkdirSync } from 'node:fs';
import { KuzuGraphStore } from '../graphstore/kuzu/adapter.js';
import { createEhrSchema } from '../graphstore/kuzu/ehr-schema.js';
import { createProjectManagerSchema } from '../graphstore/kuzu/project-manager-schema.js';

export async function initializeInstanceDb(dbPath: string, type?: string): Promise<void> {
  if (type === 'ehr') {
    return initializeEhrDb(dbPath);
  }
  if (type === 'project-manager') {
    return initializeProjectManagerDb(dbPath);
  }
  const store = new KuzuGraphStore({ dbPath, readOnly: false });
  await store.initialize();
  await store.close();
}

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

async function initializeProjectManagerDb(dbPath: string): Promise<void> {
  const parentDir = dbPath.replace(/[/\\][^/\\]+$/, '');
  if (parentDir && !existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  await conn.query('LOAD EXTENSION fts');
  await createProjectManagerSchema(conn);
  // Skip FTS creation — indexes must be built AFTER data load
  await conn.close();
  await db.close();
}
