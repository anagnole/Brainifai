import type { GraphStore } from './types.js';

export type GraphStoreBackend = 'neo4j' | 'kuzu';

export interface GraphStoreConfig {
  backend: GraphStoreBackend;
  neo4j?: {
    uri: string;
    user: string;
    password: string;
  };
  kuzu?: {
    dbPath: string;
    readOnly?: boolean;
    onDemand?: boolean;
  };
}

export async function createGraphStore(config: GraphStoreConfig): Promise<GraphStore> {
  switch (config.backend) {
    case 'neo4j': {
      if (!config.neo4j) throw new Error('neo4j config required when backend=neo4j');
      const { Neo4jGraphStore } = await import('./neo4j/adapter.js');
      return new Neo4jGraphStore(config.neo4j);
    }
    case 'kuzu': {
      if (!config.kuzu) throw new Error('kuzu config required when backend=kuzu');
      if (config.kuzu.onDemand) {
        const { OnDemandKuzuGraphStore } = await import('./kuzu/on-demand-adapter.js');
        return new OnDemandKuzuGraphStore({ dbPath: config.kuzu.dbPath, readOnly: true });
      }
      const { KuzuGraphStore } = await import('./kuzu/adapter.js');
      return new KuzuGraphStore({ dbPath: config.kuzu.dbPath, readOnly: config.kuzu.readOnly });
    }
    default:
      throw new Error(`Unknown graphstore backend: ${config.backend}`);
  }
}
