/**
 * GraphStore — backend-agnostic interface for BrainifAI's knowledge graph.
 *
 * Adapters (Neo4j, Kuzu) implement this interface. All methods are atomic;
 * adapters manage transaction boundaries internally.
 */

// ─── Generic graph primitives ────────────────────────────────────────────────

export interface GraphNode {
  label: string;
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  type: string;
  from: Record<string, unknown>;   // merge-key properties of source node
  to: Record<string, unknown>;     // merge-key properties of target node
  fromLabel: string;
  toLabel: string;
  properties?: Record<string, unknown>;
}

// ─── Search ──────────────────────────────────────────────────────────────────

export interface SearchOptions {
  query: string;
  types?: string[];               // label filter (e.g. ["Person", "Topic"])
  minScore?: number;              // default 0.3
  limit?: number;                 // default 10
}

export interface SearchResult {
  id: string;
  type: string;
  name: string;
  score: number;
}

// ─── Traversal ───────────────────────────────────────────────────────────────

export interface TraversalOptions {
  maxHops?: number;               // default 2, capped at 3
  maxNodes?: number;              // default MAX_GRAPH_NODES
  maxEdges?: number;              // default MAX_GRAPH_EDGES
  relTypes?: string[];            // filter by relationship types
  nodeLabels?: string[];          // filter by node labels
  since?: string;                 // ISO 8601 lower bound for time-filtered traversal
}

export interface Subgraph {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
}

export interface SubgraphNode {
  id: string;
  type: string;
  name: string;
}

export interface SubgraphEdge {
  source: string;
  target: string;
  type: string;
}

// ─── Timeline ────────────────────────────────────────────────────────────────

export interface TimelineOptions {
  from?: string;                  // ISO 8601
  to?: string;                    // ISO 8601
  kinds?: string[];               // activity kind filter
  limit?: number;                 // default 20
  hops?: number;                  // how far from root to look, default 2
}

export interface TimelineItem {
  timestamp: string;
  source: string;
  kind: string;
  snippet: string;
  url?: string;
  actor: string;
  channel: string;
}

// ─── Entity Summary (convenience) ────────────────────────────────────────────

export interface EntitySummary {
  id: string;
  type: string;
  name: string;
  activityCount: number;
  recentActivity?: string;
  topConnections: Array<{ name: string; type: string; weight: number }>;
}

// ─── Fact (from expand) ──────────────────────────────────────────────────────

export interface FactResult {
  name: string;
  type: string;
  activityCount: number;
  topRelated: string[];
}

// ─── Find filter ─────────────────────────────────────────────────────────────

export interface FindFilter {
  /** Match nodes where property equals value */
  [property: string]: unknown;
}

export interface PageOptions {
  limit?: number;
  offset?: number;
}

// ─── Main interface ──────────────────────────────────────────────────────────

export interface GraphStore {
  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Read — single node
  getNode(label: string, key: Record<string, unknown>): Promise<GraphNode | null>;

  // Read — filtered list
  findNodes(label: string, filter: FindFilter, page?: PageOptions): Promise<GraphNode[]>;

  // Fulltext search
  search(opts: SearchOptions): Promise<SearchResult[]>;

  // Graph traversal — 1-hop neighborhood of a single root
  neighborhood(
    rootLabel: string,
    rootKey: Record<string, unknown>,
    opts?: TraversalOptions,
  ): Promise<Subgraph>;

  // Graph traversal — multi-seed expansion with facts
  expand(
    seeds: Array<{ label: string; key: Record<string, unknown> }>,
    opts?: TraversalOptions,
  ): Promise<FactResult[]>;

  // Time-centric — activities connected to a root within a window
  timeline(
    rootLabel: string,
    rootKey: Record<string, unknown>,
    opts?: TimelineOptions,
  ): Promise<TimelineItem[]>;

  // Bulk timeline for multiple roots (deduped)
  timelineMulti(
    roots: Array<{ label: string; key: Record<string, unknown> }>,
    opts?: TimelineOptions,
  ): Promise<TimelineItem[]>;

  // Write — idempotent upsert
  upsertNodes(
    label: string,
    nodes: Record<string, unknown>[],
    mergeKeys: string[],
  ): Promise<void>;

  upsertEdges(
    type: string,
    edges: GraphEdge[],
  ): Promise<void>;

  // Cursor
  getCursor(source: string, containerId: string): Promise<string | null>;
  setCursor(source: string, containerId: string, latestTs: string): Promise<void>;

  // Entity summary (convenience — combines getNode + neighborhood)
  getEntitySummary(entityId: string): Promise<EntitySummary | null>;

  // Recent activity with filters
  getRecentActivity(opts: {
    personKey?: string;
    topic?: string;
    containerId?: string;
    kinds?: string[];
    since?: string;
    limit?: number;
  }): Promise<TimelineItem[]>;
}
