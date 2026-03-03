/**
 * On-demand KuzuGraphStore wrapper that opens/closes the database for each
 * method call. This prevents exclusive file-lock contention between the
 * long-lived MCP server process and short-lived ingestion runs.
 */
import { KuzuGraphStore, type KuzuConfig } from './adapter.js';
import { logger } from '../../shared/logger.js';
import type {
  GraphStore,
  GraphNode,
  GraphEdge,
  SearchOptions,
  SearchResult,
  TraversalOptions,
  Subgraph,
  TimelineOptions,
  TimelineItem,
  FindFilter,
  PageOptions,
  EntitySummary,
  FactResult,
} from '../types.js';

export class OnDemandKuzuGraphStore implements GraphStore {
  private readonly config: KuzuConfig;

  constructor(config: KuzuConfig) {
    // Force read-only — on-demand mode is for MCP serving, not writes
    this.config = { ...config, readOnly: true };
    logger.info({ dbPath: config.dbPath }, 'OnDemandKuzuGraphStore created (opens per-call)');
  }

  /** Open a KuzuGraphStore, run fn, then close. */
  private async withStore<T>(fn: (store: KuzuGraphStore) => Promise<T>): Promise<T> {
    const store = new KuzuGraphStore(this.config);
    try {
      await store.initialize();
      return await fn(store);
    } finally {
      await store.close();
    }
  }

  // ─── Lifecycle (no-ops) ───────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // No persistent state to initialize
  }

  async close(): Promise<void> {
    // No persistent connection to close
  }

  // ─── Read methods (delegated via withStore) ───────────────────────────────

  getNode(label: string, key: Record<string, unknown>): Promise<GraphNode | null> {
    return this.withStore((s) => s.getNode(label, key));
  }

  findNodes(label: string, filter: FindFilter, page?: PageOptions): Promise<GraphNode[]> {
    return this.withStore((s) => s.findNodes(label, filter, page));
  }

  search(opts: SearchOptions): Promise<SearchResult[]> {
    return this.withStore((s) => s.search(opts));
  }

  neighborhood(
    rootLabel: string,
    rootKey: Record<string, unknown>,
    opts?: TraversalOptions,
  ): Promise<Subgraph> {
    return this.withStore((s) => s.neighborhood(rootLabel, rootKey, opts));
  }

  expand(
    seeds: Array<{ label: string; key: Record<string, unknown> }>,
    opts?: TraversalOptions,
  ): Promise<FactResult[]> {
    return this.withStore((s) => s.expand(seeds, opts));
  }

  timeline(
    rootLabel: string,
    rootKey: Record<string, unknown>,
    opts?: TimelineOptions,
  ): Promise<TimelineItem[]> {
    return this.withStore((s) => s.timeline(rootLabel, rootKey, opts));
  }

  timelineMulti(
    roots: Array<{ label: string; key: Record<string, unknown> }>,
    opts?: TimelineOptions,
  ): Promise<TimelineItem[]> {
    return this.withStore((s) => s.timelineMulti(roots, opts));
  }

  getEntitySummary(entityId: string): Promise<EntitySummary | null> {
    return this.withStore((s) => s.getEntitySummary(entityId));
  }

  getRecentActivity(opts: {
    personKey?: string;
    topic?: string;
    containerId?: string;
    since?: string;
    limit?: number;
  }): Promise<TimelineItem[]> {
    return this.withStore((s) => s.getRecentActivity(opts));
  }

  getCursor(source: string, containerId: string): Promise<string | null> {
    return this.withStore((s) => s.getCursor(source, containerId));
  }

  // ─── Write methods (blocked in on-demand/read-only mode) ──────────────────

  async upsertNodes(): Promise<void> {
    throw new Error('OnDemandKuzuGraphStore is read-only; upsertNodes is not supported');
  }

  async upsertEdges(): Promise<void> {
    throw new Error('OnDemandKuzuGraphStore is read-only; upsertEdges is not supported');
  }

  async setCursor(): Promise<void> {
    throw new Error('OnDemandKuzuGraphStore is read-only; setCursor is not supported');
  }
}
