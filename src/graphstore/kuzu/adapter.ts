import kuzu from 'kuzu';
import type { QueryResult as KuzuQueryResult, KuzuValue } from 'kuzu';
import { existsSync, mkdirSync } from 'node:fs';
import { logger } from '../../shared/logger.js';
import {
  KUZU_MIGRATIONS,
  KUZU_NODE_TABLES,
  KUZU_REL_TABLES,
  KUZU_FTS_INDEXES,
  KUZU_FTS_DROP,
  REL_TYPE_MAP,
} from './schema.js';
import {
  GS_MAX_HOPS,
  GS_DEFAULT_HOPS,
  GS_MAX_NODES,
  GS_MAX_EDGES,
  GS_DEFAULT_SEARCH_LIMIT,
  GS_DEFAULT_TIMELINE_LIMIT,
  GS_MAX_TIMELINE_LIMIT,
  GS_DEFAULT_MIN_SCORE,
} from '../defaults.js';
import type {
  GraphStore,
  GraphNode,
  GraphEdge,
  SearchOptions,
  SearchResult,
  TraversalOptions,
  Subgraph,
  SubgraphNode,
  SubgraphEdge,
  TimelineOptions,
  TimelineItem,
  FindFilter,
  PageOptions,
  EntitySummary,
  FactResult,
} from '../types.js';

export interface KuzuConfig {
  dbPath: string;
  readOnly?: boolean;
}

function clampHops(n: number | undefined, def = GS_DEFAULT_HOPS): number {
  return Math.min(Math.max(n ?? def, 1), GS_MAX_HOPS);
}

/** Extract first QueryResult from query() return value (which may be an array for multi-statement). */
function firstResult(r: KuzuQueryResult | KuzuQueryResult[]): KuzuQueryResult {
  return Array.isArray(r) ? r[0] : r;
}

export class KuzuGraphStore implements GraphStore {
  private db: InstanceType<typeof kuzu.Database>;
  private conn: InstanceType<typeof kuzu.Connection>;
  private ftsBuilt = false;
  private readonly readOnly: boolean;

  constructor(config: KuzuConfig) {
    this.readOnly = config.readOnly ?? false;
    // Kuzu manages its own directory — just ensure the parent exists
    const parentDir = config.dbPath.replace(/[/\\][^/\\]+$/, '');
    if (parentDir && !existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    this.db = new kuzu.Database(config.dbPath, 0, true, config.readOnly ?? false);
    this.conn = new kuzu.Connection(this.db);
    logger.info({ dbPath: config.dbPath, readOnly: config.readOnly ?? false }, 'KuzuGraphStore created');
  }

  /**
   * Execute a Cypher query with optional parameters.
   * Uses prepare + execute for parameterized queries.
   */
  private async query(cypher: string, params?: Record<string, KuzuValue>): Promise<Record<string, KuzuValue>[]> {
    if (params && Object.keys(params).length > 0) {
      const ps = await this.conn.prepare(cypher);
      const result = await this.conn.execute(ps, params);
      return firstResult(result).getAll();
    }
    const result = await this.conn.query(cypher);
    return firstResult(result).getAll();
  }

  /**
   * Execute a statement that doesn't return rows (DDL, DML).
   */
  private async exec(cypher: string, params?: Record<string, KuzuValue>): Promise<void> {
    if (params && Object.keys(params).length > 0) {
      const ps = await this.conn.prepare(cypher);
      await this.conn.execute(ps, params);
    } else {
      await this.conn.query(cypher);
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // Load FTS extension
    await this.exec('LOAD EXTENSION fts');

    if (this.readOnly) {
      // Read-only: schema already exists (written by ingestion); skip DDL
      this.ftsBuilt = true;
      logger.info('Kuzu opened read-only — skipping schema DDL');
      return;
    }

    // Create node tables
    for (const stmt of KUZU_NODE_TABLES) {
      await this.exec(stmt);
    }
    // Create rel tables
    for (const stmt of KUZU_REL_TABLES) {
      await this.exec(stmt);
    }

    // Run migrations (add columns to existing tables — safe to re-run)
    for (const stmt of KUZU_MIGRATIONS) {
      try { await this.exec(stmt); } catch { /* column/table may already exist */ }
    }

    logger.info('Kuzu schema tables created');
    await this.rebuildFtsIndexes();
  }

  /** Rebuild FTS indexes (required after data changes since Kuzu FTS is immutable). */
  async rebuildFtsIndexes(): Promise<void> {
    // Drop existing indexes (ignore errors if they don't exist)
    for (const stmt of KUZU_FTS_DROP) {
      try { await this.exec(stmt); } catch { /* index may not exist */ }
    }
    // Create fresh indexes
    for (const stmt of KUZU_FTS_INDEXES) {
      try { await this.exec(stmt); } catch { /* table may be empty */ }
    }
    this.ftsBuilt = true;
    logger.info('Kuzu FTS indexes rebuilt');
  }

  async close(): Promise<void> {
    await this.conn.close();
    await this.db.close();
    logger.info('KuzuGraphStore closed');
  }

  // ─── Read ──────────────────────────────────────────────────────────────────

  async getNode(label: string, key: Record<string, unknown>): Promise<GraphNode | null> {
    const keys = Object.keys(key);
    const whereClause = keys.map((k) => `n.${k} = $${k}`).join(' AND ');
    const rows = await this.query(
      `MATCH (n:${label}) WHERE ${whereClause} RETURN n LIMIT 1`,
      key as Record<string, KuzuValue>,
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const props = row.n as Record<string, KuzuValue>;
    // Strip internal Kuzu properties
    const { _label, _id, ...rest } = props;
    return { label, properties: rest };
  }

  async findNodes(label: string, filter: FindFilter, page?: PageOptions): Promise<GraphNode[]> {
    const keys = Object.keys(filter);
    const whereClause = keys.length > 0
      ? 'WHERE ' + keys.map((k) => `n.${k} = $${k}`).join(' AND ')
      : '';
    const limit = page?.limit ?? 100;
    const skip = page?.offset ?? 0;
    const rows = await this.query(
      `MATCH (n:${label}) ${whereClause} RETURN n SKIP ${skip} LIMIT ${limit}`,
      filter as Record<string, KuzuValue>,
    );
    return rows.map((r) => {
      const props = r.n as Record<string, KuzuValue>;
      const { _label, _id, ...rest } = props;
      return { label, properties: rest };
    });
  }

  // ─── Search (FTS) ─────────────────────────────────────────────────────────

  async search(opts: SearchOptions): Promise<SearchResult[]> {
    const minScore = opts.minScore ?? GS_DEFAULT_MIN_SCORE;
    const limit = opts.limit ?? GS_DEFAULT_SEARCH_LIMIT;

    if (!this.ftsBuilt) {
      await this.rebuildFtsIndexes();
    }

    const results: SearchResult[] = [];
    const tables: Array<{
      table: string;
      index: string;
      type: string;
      idExpr: string;
      nameExpr: string;
    }> = [
      {
        table: 'Person',
        index: 'person_fts',
        type: 'Person',
        idExpr: 'node.person_key',
        nameExpr: 'node.display_name',
      },
      {
        table: 'Topic',
        index: 'topic_fts',
        type: 'Topic',
        idExpr: 'node.name',
        nameExpr: 'node.name',
      },
      {
        table: 'Container',
        index: 'container_fts',
        type: 'Container',
        idExpr: 'node.source + ":" + node.container_id',
        nameExpr: 'node.name',
      },
      {
        table: 'Activity',
        index: 'activity_fts',
        type: 'Activity',
        idExpr: 'node.source_id',
        nameExpr: 'CASE WHEN length(node.snippet) > 80 THEN left(node.snippet, 80) + "…" ELSE node.snippet END',
      },
    ];

    // Filter which tables to search based on types
    const filteredTables = opts.types && opts.types.length > 0
      ? tables.filter((t) => opts.types!.includes(t.type))
      : tables;

    const safeQuery = opts.query.replace(/'/g, "''");

    for (const t of filteredTables) {
      try {
        const rows = await this.query(
          `CALL QUERY_FTS_INDEX('${t.table}', '${t.index}', '${safeQuery}')
           RETURN ${t.idExpr} AS id, '${t.type}' AS type, ${t.nameExpr} AS name, score
           ORDER BY score DESC
           LIMIT ${limit}`,
        );
        for (const r of rows) {
          const score = r.score as number;
          if (score > minScore) {
            results.push({
              id: r.id as string,
              type: r.type as string,
              name: r.name as string,
              score,
            });
          }
        }
      } catch {
        // FTS index may be empty or not yet built for this table
      }
    }

    // Sort by score DESC, take top `limit`
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  // ─── Neighborhood ──────────────────────────────────────────────────────────

  async neighborhood(
    rootLabel: string,
    rootKey: Record<string, unknown>,
    opts?: TraversalOptions,
  ): Promise<Subgraph> {
    const maxNodes = opts?.maxNodes ?? GS_MAX_NODES;
    const maxEdges = opts?.maxEdges ?? GS_MAX_EDGES;

    const whereClause = Object.keys(rootKey)
      .map((k) => `root.${k} = $${k}`)
      .join(' AND ');

    const rootIdExpr = KuzuGraphStore.idExprFor('root', rootLabel);
    const rootNameExpr = KuzuGraphStore.nameExprFor('root', rootLabel);

    // Get root node info (label-specific expressions since Kuzu is strict)
    const rootRows = await this.query(
      `MATCH (root:${rootLabel}) WHERE ${whereClause}
       RETURN ${rootIdExpr} AS id, label(root) AS type, ${rootNameExpr} AS name`,
      rootKey as Record<string, KuzuValue>,
    );

    if (rootRows.length === 0) return { nodes: [], edges: [] };

    const nodes: SubgraphNode[] = [{
      id: rootRows[0].id as string,
      type: rootRows[0].type as string,
      name: rootRows[0].name as string,
    }];
    const edges: SubgraphEdge[] = [];
    const seenIds = new Set<string>([rootRows[0].id as string]);

    // Rel tables define their FROM→TO types, so we know the neighbor label
    const relToNeighborLabel: Record<string, string> = {
      FROM_PERSON: 'Activity',    // Activity→Person, so incoming neighbor is Activity
      IN_CONTAINER: 'Activity',   // Activity→Container
      MENTIONS: 'Activity',       // Activity→Topic
      IDENTIFIES: 'SourceAccount',// SourceAccount→Person
      OWNS: 'SourceAccount',      // SourceAccount→Activity
      REPLIES_TO: 'Activity',     // Activity→Activity (reply→parent)
      MENTIONS_PERSON: 'Activity',// Activity→Person (mention)
    };

    for (const relTable of this.allRelTypes()) {
      const neighborLabel = relToNeighborLabel[relTable];
      if (!neighborLabel) continue;

      const nIdExpr = KuzuGraphStore.idExprFor('neighbor', neighborLabel);
      const nNameExpr = KuzuGraphStore.nameExprFor('neighbor', neighborLabel);

      try {
        const neighborRows = await this.query(
          `MATCH (root:${rootLabel})<-[r:${relTable}]-(neighbor:${neighborLabel})
           WHERE ${whereClause}
           RETURN ${nIdExpr} AS nid, label(neighbor) AS ntype, ${nNameExpr} AS nname
           LIMIT ${maxEdges}`,
          rootKey as Record<string, KuzuValue>,
        );

        for (const nr of neighborRows) {
          const nid = nr.nid as string;
          if (!seenIds.has(nid) && nodes.length < maxNodes) {
            nodes.push({ id: nid, type: nr.ntype as string, name: nr.nname as string });
            seenIds.add(nid);
          }
          if (edges.length < maxEdges) {
            edges.push({ source: rootRows[0].id as string, target: nid, type: relTable });
          }
        }
      } catch {
        // Rel type may not connect to this node label — skip
      }
    }

    return { nodes, edges };
  }

  // ─── Expand ────────────────────────────────────────────────────────────────

  async expand(
    seeds: Array<{ label: string; key: Record<string, unknown> }>,
    opts?: TraversalOptions,
  ): Promise<FactResult[]> {
    const results: FactResult[] = [];

    for (const seed of seeds) {
      const whereClause = Object.keys(seed.key)
        .map((k) => `anchor.${k} = $${k}`)
        .join(' AND ');

      // Count activities
      let actCount = 0;
      const sinceFilter = opts?.since ? `AND a.timestamp >= '${opts.since}'` : '';

      try {
        const countRows = await this.query(
          `MATCH (anchor:${seed.label})<-[*1..2]-(a:Activity)
           WHERE ${whereClause} ${sinceFilter}
           RETURN count(DISTINCT a) AS cnt`,
          seed.key as Record<string, KuzuValue>,
        );
        actCount = (countRows[0]?.cnt as number) ?? 0;
      } catch {
        // May fail if no path exists
      }

      // Get name (label-specific since Kuzu is strict about property access)
      let name = '';
      let type = seed.label;
      const nameExpr = KuzuGraphStore.nameExprFor('anchor', seed.label);
      try {
        const nameRows = await this.query(
          `MATCH (anchor:${seed.label}) WHERE ${whereClause}
           RETURN ${nameExpr} AS name, label(anchor) AS type`,
          seed.key as Record<string, KuzuValue>,
        );
        if (nameRows.length > 0) {
          name = nameRows[0].name as string;
          type = nameRows[0].type as string;
        }
      } catch { /* skip */ }

      // Top related entities — query per target label (Kuzu strict schema)
      const topRelated: Array<{ text: string; weight: number }> = [];
      const targetLabels: Array<{ tLabel: string; nameExpr: string }> = [
        { tLabel: 'Person', nameExpr: 'other.display_name' },
        { tLabel: 'Topic', nameExpr: 'other.name' },
        { tLabel: 'Container', nameExpr: 'other.name' },
      ];
      for (const tl of targetLabels) {
        try {
          const relatedRows = await this.query(
            `MATCH (anchor:${seed.label})<-[*1..2]-(a2:Activity)-[*1..2]->(other:${tl.tLabel})
             WHERE ${whereClause}
               ${sinceFilter.replace('a.', 'a2.')}
             RETURN ${tl.nameExpr} AS otherName,
                    label(other) AS otherType,
                    count(*) AS weight
             ORDER BY weight DESC
             LIMIT 3`,
            seed.key as Record<string, KuzuValue>,
          );
          for (const r of relatedRows) {
            topRelated.push({
              text: `${r.otherName} (${r.otherType})`,
              weight: r.weight as number,
            });
          }
        } catch { /* skip */ }
      }
      topRelated.sort((a, b) => b.weight - a.weight);
      const topRelatedStrings = topRelated.slice(0, 3).map((r) => r.text);

      results.push({ name, type, activityCount: actCount, topRelated: topRelatedStrings });
    }

    return results;
  }

  // ─── Timeline ──────────────────────────────────────────────────────────────

  async timeline(
    rootLabel: string,
    rootKey: Record<string, unknown>,
    opts?: TimelineOptions,
  ): Promise<TimelineItem[]> {
    return this.timelineMulti([{ label: rootLabel, key: rootKey }], opts);
  }

  async timelineMulti(
    roots: Array<{ label: string; key: Record<string, unknown> }>,
    opts?: TimelineOptions,
  ): Promise<TimelineItem[]> {
    const limit = Math.min(opts?.limit ?? GS_DEFAULT_TIMELINE_LIMIT, GS_MAX_TIMELINE_LIMIT);
    const hops = clampHops(opts?.hops);
    const allItems: TimelineItem[] = [];
    const seenIds = new Set<string>();

    for (const root of roots) {
      const whereClause = Object.keys(root.key)
        .map((k) => `anchor.${k} = $${k}`)
        .join(' AND ');

      const timeFilters: string[] = [];
      if (opts?.from) timeFilters.push(`a.timestamp >= '${opts.from}'`);
      if (opts?.to) timeFilters.push(`a.timestamp <= '${opts.to}'`);
      if (opts?.kinds && opts.kinds.length > 0) {
        timeFilters.push(`a.kind IN ['${opts.kinds.join("','")}']`);
      }
      const extraWhere = timeFilters.length > 0 ? 'AND ' + timeFilters.join(' AND ') : '';

      try {
        const rows = await this.query(
          `MATCH (anchor:${root.label})<-[*1..${hops}]-(a:Activity)
           WHERE ${whereClause} ${extraWhere}
           WITH DISTINCT a
           MATCH (a)-[:FROM_PERSON]->(person:Person)
           MATCH (a)-[:IN_CONTAINER]->(chan:Container)
           RETURN a.timestamp AS timestamp,
                  a.source AS source,
                  a.kind AS kind,
                  a.snippet AS snippet,
                  a.url AS url,
                  coalesce(person.display_name, person.person_key) AS actor,
                  chan.name AS channel,
                  a.source_id AS _sid
           ORDER BY a.timestamp DESC
           LIMIT ${limit}`,
          root.key as Record<string, KuzuValue>,
        );

        for (const r of rows) {
          const sid = r._sid as string;
          if (!seenIds.has(sid)) {
            seenIds.add(sid);
            allItems.push({
              timestamp: r.timestamp as string,
              source: r.source as string,
              kind: r.kind as string,
              snippet: r.snippet as string,
              url: (r.url as string) ?? undefined,
              actor: r.actor as string,
              channel: r.channel as string,
            });
          }
        }
      } catch {
        // No path found — skip
      }
    }

    // Sort by timestamp DESC and limit
    allItems.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return allItems.slice(0, limit);
  }

  // ─── Write ─────────────────────────────────────────────────────────────────

  async upsertNodes(
    label: string,
    nodes: Record<string, unknown>[],
    mergeKeys: string[],
  ): Promise<void> {
    if (nodes.length === 0) return;

    for (const node of nodes) {
      const mergeClause = mergeKeys.map((k) => `${k}: $${k}`).join(', ');
      const allKeys = Object.keys(node);
      const setKeys = allKeys.filter((k) => !mergeKeys.includes(k));
      const onCreateSet = setKeys.length > 0
        ? 'ON CREATE SET ' + setKeys.map((k) => `n.${k} = $${k}`).join(', ')
        : '';
      const onMatchSet = setKeys.length > 0
        ? 'ON MATCH SET ' + setKeys.map((k) => `n.${k} = $${k}`).join(', ')
        : '';

      await this.exec(
        `MERGE (n:${label} {${mergeClause}})
         ${onCreateSet}
         ${onMatchSet}`,
        node as Record<string, KuzuValue>,
      );
    }

    // Invalidate FTS since data changed
    this.ftsBuilt = false;
  }

  async upsertEdges(type: string, edges: GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;

    const kuzuRelType = REL_TYPE_MAP[type] ?? type;

    for (const edge of edges) {
      const fromKeys = Object.keys(edge.from);
      const toKeys = Object.keys(edge.to);

      const fromMatch = fromKeys.map((k) => `${k}: $from_${k}`).join(', ');
      const toMatch = toKeys.map((k) => `${k}: $to_${k}`).join(', ');

      const params: Record<string, KuzuValue> = {};
      for (const [k, v] of Object.entries(edge.from)) params[`from_${k}`] = v as KuzuValue;
      for (const [k, v] of Object.entries(edge.to)) params[`to_${k}`] = v as KuzuValue;

      // Build property SET clause for edge properties
      const propKeys = edge.properties ? Object.keys(edge.properties) : [];
      let propSet = '';
      if (propKeys.length > 0) {
        for (const [k, v] of Object.entries(edge.properties!)) params[`prop_${k}`] = v as KuzuValue;
        propSet = 'ON CREATE SET ' + propKeys.map((k) => `r.${k} = $prop_${k}`).join(', ');
      }

      await this.exec(
        `MATCH (a:${edge.fromLabel} {${fromMatch}})
         MATCH (b:${edge.toLabel} {${toMatch}})
         MERGE (a)-[r:${kuzuRelType}]->(b)
         ${propSet}`,
        params,
      );
    }
  }

  // ─── Cursor ────────────────────────────────────────────────────────────────

  async getCursor(source: string, containerId: string): Promise<string | null> {
    const rows = await this.query(
      `MATCH (cur:Cursor {container_id: $containerId})
       WHERE cur.source = $source
       RETURN cur.latest_ts AS latest_ts`,
      { source, containerId },
    );
    return rows.length > 0 ? (rows[0].latest_ts as string) : null;
  }

  async setCursor(source: string, containerId: string, latestTs: string): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.exec(
      `MERGE (cur:Cursor {container_id: $containerId})
       ON CREATE SET cur.source = $source, cur.latest_ts = $latestTs, cur.updated_at = $updatedAt
       ON MATCH SET cur.latest_ts = $latestTs, cur.updated_at = $updatedAt`,
      { source, containerId, latestTs, updatedAt },
    );
  }

  // ─── Entity Summary ────────────────────────────────────────────────────────

  async getEntitySummary(entityId: string): Promise<EntitySummary | null> {
    // Try each label
    for (const { label, keyExpr, nameExpr, key } of this.resolveEntityId(entityId)) {
      try {
        const whereClause = Object.keys(key)
          .map((k) => `entity.${k} = $${k}`)
          .join(' AND ');

        // Basic info (label-specific expressions since Kuzu is strict)
        const infoRows = await this.query(
          `MATCH (entity:${label}) WHERE ${whereClause}
           RETURN
             ${keyExpr} AS id,
             label(entity) AS type,
             ${nameExpr} AS name`,
          key as Record<string, KuzuValue>,
        );
        if (infoRows.length === 0) continue;

        const info = infoRows[0];

        // Activity count
        let activityCount = 0;
        let recentActivity: string | undefined;
        try {
          const actRows = await this.query(
            `MATCH (entity:${label})<-[*1..2]-(a:Activity)
             WHERE ${whereClause}
             RETURN count(DISTINCT a) AS cnt, max(a.timestamp) AS latestTs`,
            key as Record<string, KuzuValue>,
          );
          if (actRows.length > 0) {
            activityCount = (actRows[0].cnt as number) ?? 0;
            recentActivity = (actRows[0].latestTs as string) ?? undefined;
          }
        } catch { /* no activities */ }

        // Top connections — query each target label separately (Kuzu strict schema)
        const topConnections: Array<{ name: string; type: string; weight: number }> = [];
        const targetLabels: Array<{ tLabel: string; idExpr: string; nameExpr: string }> = [
          { tLabel: 'Person', idExpr: 'other.person_key', nameExpr: 'other.display_name' },
          { tLabel: 'Topic', idExpr: 'other.name', nameExpr: 'other.name' },
          { tLabel: 'Container', idExpr: 'other.container_id', nameExpr: 'other.name' },
        ];
        for (const tl of targetLabels) {
          if (tl.tLabel === label) continue; // skip self-type to avoid reflexive match
          try {
            const connRows = await this.query(
              `MATCH (entity:${label})<-[*1..2]-(a:Activity)-[*1..2]->(other:${tl.tLabel})
               WHERE ${whereClause}
               RETURN ${tl.nameExpr} AS name,
                      label(other) AS type,
                      count(*) AS weight
               ORDER BY weight DESC
               LIMIT 5`,
              key as Record<string, KuzuValue>,
            );
            for (const r of connRows) {
              topConnections.push({
                name: r.name as string,
                type: r.type as string,
                weight: r.weight as number,
              });
            }
          } catch { /* skip */ }
        }
        topConnections.sort((a, b) => b.weight - a.weight);
        const top10 = topConnections.slice(0, 10);

        return {
          id: info.id as string,
          type: info.type as string,
          name: info.name as string,
          activityCount,
          recentActivity,
          topConnections: top10,
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  // ─── Recent Activity ───────────────────────────────────────────────────────

  async getRecentActivity(opts: {
    personKey?: string;
    topic?: string;
    containerId?: string;
    since?: string;
    limit?: number;
  }): Promise<TimelineItem[]> {
    const limit = Math.min(opts.limit ?? GS_DEFAULT_TIMELINE_LIMIT, GS_MAX_TIMELINE_LIMIT);
    const filters: string[] = [];
    const params: Record<string, KuzuValue> = {};

    if (opts.since) {
      filters.push('a.timestamp >= $since');
      params.since = opts.since;
    }
    if (opts.personKey) {
      filters.push('p.person_key = $personKey');
      params.personKey = opts.personKey;
    }
    if (opts.containerId) {
      filters.push('c.container_id = $containerId');
      params.containerId = opts.containerId;
    }

    const whereClause = filters.length > 0 ? 'WHERE ' + filters.join(' AND ') : '';

    // Topic filter requires a separate MATCH
    const topicMatch = opts.topic
      ? `MATCH (a)-[:MENTIONS]->(:Topic {name: $topic})`
      : '';
    if (opts.topic) params.topic = opts.topic.toLowerCase();

    const rows = await this.query(
      `MATCH (a:Activity)-[:FROM_PERSON]->(p:Person)
       MATCH (a)-[:IN_CONTAINER]->(c:Container)
       ${topicMatch}
       ${whereClause}
       RETURN a.timestamp AS timestamp,
              a.source AS source,
              a.kind AS kind,
              a.snippet AS snippet,
              a.url AS url,
              coalesce(p.display_name, p.person_key) AS actor,
              c.name AS channel
       ORDER BY a.timestamp DESC
       LIMIT ${limit}`,
      params,
    );

    return rows.map((r) => ({
      timestamp: r.timestamp as string,
      source: r.source as string,
      kind: r.kind as string,
      snippet: r.snippet as string,
      url: (r.url as string) ?? undefined,
      actor: r.actor as string,
      channel: r.channel as string,
    }));
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Kuzu is strict about property access — each label has a fixed schema.
   * These helpers return label-specific expressions for ID and display name.
   */
  private static idExprFor(alias: string, label: string): string {
    switch (label) {
      case 'Person': return `${alias}.person_key`;
      case 'Container': return `${alias}.source + ':' + ${alias}.container_id`;
      case 'Activity': return `${alias}.source_id`;
      case 'Topic': return `${alias}.name`;
      case 'SourceAccount': return `${alias}.source + ':' + ${alias}.account_id`;
      default: return `${alias}.name`;
    }
  }

  private static nameExprFor(alias: string, label: string): string {
    switch (label) {
      case 'Person': return `${alias}.display_name`;
      case 'Activity': return `${alias}.snippet`;
      default: return `${alias}.name`;
    }
  }

  private resolveEntityId(entityId: string): Array<{
    label: string;
    keyExpr: string;
    nameExpr: string;
    key: Record<string, unknown>;
  }> {
    return [
      {
        label: 'Person',
        keyExpr: 'entity.person_key',
        nameExpr: 'entity.display_name',
        key: { person_key: entityId },
      },
      {
        label: 'Topic',
        keyExpr: 'entity.name',
        nameExpr: 'entity.name',
        key: { name: entityId },
      },
      {
        label: 'Container',
        keyExpr: "entity.source + ':' + entity.container_id",
        nameExpr: 'entity.name',
        key: (() => {
          const idx = entityId.indexOf(':');
          return idx > 0
            ? { source: entityId.slice(0, idx), container_id: entityId.slice(idx + 1) }
            : { container_id: entityId };
        })(),
      },
    ];
  }

  private allRelTypes(): string[] {
    return Object.values(REL_TYPE_MAP);
  }
}
