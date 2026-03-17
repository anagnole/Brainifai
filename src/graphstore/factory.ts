import type { GraphStore } from './types.js';

export interface GraphStoreConfig {
  kuzu: {
    dbPath: string;
    readOnly?: boolean;
    onDemand?: boolean;
  };
}

export async function createGraphStore(config: GraphStoreConfig): Promise<GraphStore> {
  if (config.kuzu.onDemand) {
    const { OnDemandKuzuGraphStore } = await import('./kuzu/on-demand-adapter.js');
    return new OnDemandKuzuGraphStore({ dbPath: config.kuzu.dbPath, readOnly: true });
  }
  const { KuzuGraphStore } = await import('./kuzu/adapter.js');
  return new KuzuGraphStore({ dbPath: config.kuzu.dbPath, readOnly: config.kuzu.readOnly });
}
