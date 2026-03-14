import { KuzuGraphStore } from '../graphstore/kuzu/adapter.js';

/** Initialize a fresh Kuzu DB with the standard schema at the given path */
export async function initializeInstanceDb(dbPath: string): Promise<void> {
  const store = new KuzuGraphStore({ dbPath, readOnly: false });
  await store.initialize();
  await store.close();
}
