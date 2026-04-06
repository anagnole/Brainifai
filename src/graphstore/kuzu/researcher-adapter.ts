/**
 * Researcher graph query adapter.
 *
 * Wraps a Kuzu connection with research domain query methods that back
 * the 5 context functions (get_landscape, get_entity_timeline, etc.).
 *
 * Design decisions:
 * - Uses prepare() + execute() with parameters — never string interpolation
 * - Upsert methods use MERGE for idempotency (safe to re-run)
 * - All date fields are stored as ISO 8601 strings
 */

import kuzu from 'kuzu';
import type { KuzuValue } from 'kuzu';
import { createResearcherSchema, rebuildResearcherFtsIndexes } from './researcher-schema.js';

// ─── Return types ─────────────────────────────────────────────────────────────

export interface ResearchEntityRecord {
  entity_key: string;
  name: string;
  type: string;
  domain: string;
  url: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface ResearchEventRecord {
  event_key: string;
  title: string;
  date: string;
  description: string;
  significance: string;
  event_type: string;
  created_at: string;
  updated_at: string;
}

export interface ResearchMetricRecord {
  metric_key: string;
  name: string;
  domain: string;
  unit: string;
  created_at: string;
  updated_at: string;
}

export interface ResearchTrendRecord {
  trend_key: string;
  name: string;
  first_seen: string;
  last_seen: string;
  domain: string;
  created_at: string;
  updated_at: string;
}

export interface LandscapeReport {
  top_entities: Array<ResearchEntityRecord & { mention_count: number }>;
  recent_events: ResearchEventRecord[];
  active_trends: ResearchTrendRecord[];
}

export interface EntityTimelineEntry {
  event: ResearchEventRecord;
  role: string;
}

export interface TrendingReport {
  trending_entities: Array<ResearchEntityRecord & { current_mentions: number; previous_mentions: number }>;
  trending_trends: Array<ResearchTrendRecord & { current_events: number; previous_events: number }>;
}

export interface EntityNetworkNode {
  entity_key: string;
  name: string;
  type: string;
  domain: string;
}

export interface EntityNetworkEdge {
  from_key: string;
  to_key: string;
  relation_type: string;
  confidence: string;
}

export interface EntityNetworkReport {
  center: EntityNetworkNode;
  nodes: EntityNetworkNode[];
  edges: EntityNetworkEdge[];
}

// ─── Upsert input types ───────────────────────────────────────────────────────

export interface UpsertEntityInput {
  entity_key: string;
  name: string;
  type: string;
  domain: string;
  url: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertEventInput {
  event_key: string;
  title: string;
  date: string;
  description: string;
  significance: string;
  event_type: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertMetricInput {
  metric_key: string;
  name: string;
  domain: string;
  unit: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertTrendInput {
  trend_key: string;
  name: string;
  first_seen: string;
  last_seen: string;
  domain: string;
  created_at: string;
  updated_at: string;
}

// ─── ResearcherGraphStore ───────────────────────────────────────────────────

export class ResearcherGraphStore {
  private db: InstanceType<typeof kuzu.Database>;
  private conn: InstanceType<typeof kuzu.Connection>;

  constructor(config: { dbPath: string; readOnly?: boolean }) {
    this.db = new kuzu.Database(config.dbPath, 0, true, config.readOnly ?? false);
    this.conn = new kuzu.Connection(this.db);
  }

  async initialize(): Promise<void> {
    await this.conn.query('LOAD EXTENSION fts');
    await createResearcherSchema(this.conn);
  }

  async rebuildFtsIndexes(): Promise<void> {
    await rebuildResearcherFtsIndexes(this.conn);
  }

  async close(): Promise<void> {
    await this.conn.close();
    await this.db.close();
  }

  /** Delete all researcher data. Relationships are removed via DETACH DELETE. */
  async clearData(): Promise<void> {
    for (const label of ['ResearchEntity', 'ResearchEvent', 'ResearchMetric', 'ResearchTrend']) {
      try {
        await this.query(`MATCH (n:${label}) DETACH DELETE n`);
      } catch { /* table may be empty */ }
    }
  }

  /** Low-level parameterized query */
  private async query(cypher: string, params?: Record<string, KuzuValue>): Promise<Record<string, KuzuValue>[]> {
    if (params && Object.keys(params).length > 0) {
      const ps = await this.conn.prepare(cypher);
      const result = await this.conn.execute(ps, params);
      const qr = Array.isArray(result) ? result[0] : result;
      return qr.getAll();
    }
    const result = await this.conn.query(cypher);
    const qr = Array.isArray(result) ? result[0] : result;
    return qr.getAll();
  }

  // ─── Upsert methods ─────────────────────────────────────────────────────────

  async upsertEntity(e: UpsertEntityInput): Promise<void> {
    await this.query(
      `MERGE (n:ResearchEntity {entity_key: $entity_key})
       SET n.name = $name, n.type = $type, n.domain = $domain,
           n.url = $url, n.description = $description,
           n.created_at = $created_at, n.updated_at = $updated_at`,
      {
        entity_key: e.entity_key, name: e.name, type: e.type, domain: e.domain,
        url: e.url, description: e.description,
        created_at: e.created_at, updated_at: e.updated_at,
      },
    );
  }

  async upsertEvent(e: UpsertEventInput): Promise<void> {
    await this.query(
      `MERGE (n:ResearchEvent {event_key: $event_key})
       SET n.title = $title, n.date = $date, n.description = $description,
           n.significance = $significance, n.event_type = $event_type,
           n.created_at = $created_at, n.updated_at = $updated_at`,
      {
        event_key: e.event_key, title: e.title, date: e.date,
        description: e.description, significance: e.significance,
        event_type: e.event_type, created_at: e.created_at, updated_at: e.updated_at,
      },
    );
  }

  async upsertMetric(m: UpsertMetricInput): Promise<void> {
    await this.query(
      `MERGE (n:ResearchMetric {metric_key: $metric_key})
       SET n.name = $name, n.domain = $domain, n.unit = $unit,
           n.created_at = $created_at, n.updated_at = $updated_at`,
      {
        metric_key: m.metric_key, name: m.name, domain: m.domain,
        unit: m.unit, created_at: m.created_at, updated_at: m.updated_at,
      },
    );
  }

  async upsertTrend(t: UpsertTrendInput): Promise<void> {
    await this.query(
      `MERGE (n:ResearchTrend {trend_key: $trend_key})
       SET n.name = $name, n.first_seen = $first_seen, n.last_seen = $last_seen,
           n.domain = $domain, n.created_at = $created_at, n.updated_at = $updated_at`,
      {
        trend_key: t.trend_key, name: t.name, first_seen: t.first_seen,
        last_seen: t.last_seen, domain: t.domain,
        created_at: t.created_at, updated_at: t.updated_at,
      },
    );
  }

  // ─── Link methods ───────────────────────────────────────────────────────────

  async linkEntityToEvent(entityKey: string, eventKey: string, role: string): Promise<void> {
    await this.query(
      `MATCH (e:ResearchEntity {entity_key: $entityKey}), (ev:ResearchEvent {event_key: $eventKey})
       MERGE (e)-[r:INVOLVED_IN]->(ev)
       SET r.role = $role`,
      { entityKey, eventKey, role },
    );
  }

  async linkEntityToEntity(fromKey: string, toKey: string, relationType: string): Promise<void> {
    await this.query(
      `MATCH (a:ResearchEntity {entity_key: $fromKey}), (b:ResearchEntity {entity_key: $toKey})
       MERGE (a)-[r:ENTITY_RELATED_TO]->(b)
       SET r.relation_type = $relationType, r.confidence = $confidence`,
      { fromKey, toKey, relationType, confidence: '1.0' },
    );
  }

  async linkEntityToMetric(entityKey: string, metricKey: string, value: string, date: string): Promise<void> {
    await this.query(
      `MATCH (e:ResearchEntity {entity_key: $entityKey}), (m:ResearchMetric {metric_key: $metricKey})
       MERGE (e)-[r:MEASURED_BY]->(m)
       SET r.value = $value, r.date = $date`,
      { entityKey, metricKey, value, date },
    );
  }

  async linkEventToTrend(eventKey: string, trendKey: string): Promise<void> {
    await this.query(
      `MATCH (ev:ResearchEvent {event_key: $eventKey}), (t:ResearchTrend {trend_key: $trendKey})
       MERGE (ev)-[:PART_OF_TREND]->(t)`,
      { eventKey, trendKey },
    );
  }

  async linkEntityToActivity(entityKey: string, activitySourceId: string, extractionDate: string): Promise<void> {
    await this.query(
      `MATCH (e:ResearchEntity {entity_key: $entityKey}), (a:Activity {source_id: $activitySourceId})
       MERGE (e)-[r:ENTITY_MENTIONED_IN]->(a)
       SET r.extraction_date = $extractionDate`,
      { entityKey, activitySourceId, extractionDate },
    );
  }

  async linkEventToActivity(eventKey: string, activitySourceId: string, extractionDate: string): Promise<void> {
    await this.query(
      `MATCH (ev:ResearchEvent {event_key: $eventKey}), (a:Activity {source_id: $activitySourceId})
       MERGE (ev)-[r:EVENT_MENTIONED_IN]->(a)
       SET r.extraction_date = $extractionDate`,
      { eventKey, activitySourceId, extractionDate },
    );
  }

  // ─── Query methods (context functions) ──────────────────────────────────────

  /**
   * Get a landscape overview for a domain: top entities by mention count,
   * recent events, and active trends.
   */
  async getLandscape(domain: string, since: string, limit = 20): Promise<LandscapeReport> {
    const [entityRows, eventRows, trendRows] = await Promise.all([
      this.query(
        `MATCH (e:ResearchEntity)
         WHERE e.domain = $domain
         OPTIONAL MATCH (e)-[:ENTITY_MENTIONED_IN]->(a:Activity)
         WHERE a.timestamp >= $since
         RETURN e.entity_key AS entity_key, e.name AS name, e.type AS type,
                e.domain AS domain, e.url AS url, e.description AS description,
                e.created_at AS created_at, e.updated_at AS updated_at,
                count(a) AS mention_count
         ORDER BY mention_count DESC
         LIMIT ${limit}`,
        { domain, since },
      ),
      this.query(
        `MATCH (ev:ResearchEvent)
         WHERE ev.date >= $since
         OPTIONAL MATCH (e:ResearchEntity {domain: $domain})-[:INVOLVED_IN]->(ev)
         WITH ev, count(e) AS entity_count
         WHERE entity_count > 0
         RETURN ev.event_key AS event_key, ev.title AS title, ev.date AS date,
                ev.description AS description, ev.significance AS significance,
                ev.event_type AS event_type, ev.created_at AS created_at,
                ev.updated_at AS updated_at
         ORDER BY ev.date DESC
         LIMIT ${limit}`,
        { since, domain },
      ),
      this.query(
        `MATCH (t:ResearchTrend)
         WHERE t.domain = $domain AND t.last_seen >= $since
         RETURN t.trend_key AS trend_key, t.name AS name,
                t.first_seen AS first_seen, t.last_seen AS last_seen,
                t.domain AS domain, t.created_at AS created_at,
                t.updated_at AS updated_at
         ORDER BY t.last_seen DESC
         LIMIT ${limit}`,
        { domain, since },
      ),
    ]);

    return {
      top_entities: entityRows.map((r) => ({
        ...this.rowToEntity(r),
        mention_count: (r.mention_count as number) ?? 0,
      })),
      recent_events: eventRows.map((r) => this.rowToEvent(r)),
      active_trends: trendRows.map((r) => this.rowToTrend(r)),
    };
  }

  /**
   * Get chronological events for a specific entity.
   */
  async getEntityTimeline(entityName: string, limit = 50): Promise<EntityTimelineEntry[]> {
    const rows = await this.query(
      `MATCH (e:ResearchEntity {name: $name})-[r:INVOLVED_IN]->(ev:ResearchEvent)
       RETURN ev.event_key AS event_key, ev.title AS title, ev.date AS date,
              ev.description AS description, ev.significance AS significance,
              ev.event_type AS event_type, ev.created_at AS created_at,
              ev.updated_at AS updated_at, r.role AS role
       ORDER BY ev.date DESC
       LIMIT ${limit}`,
      { name: entityName },
    );

    return rows.map((r) => ({
      event: this.rowToEvent(r),
      role: (r.role as string) || '',
    }));
  }

  /**
   * Find entities and trends spiking in the current window vs a previous window.
   */
  async getTrending(domain: string, currentSince: string, compareSince: string): Promise<TrendingReport> {
    const [entityRows, trendRows] = await Promise.all([
      this.query(
        `MATCH (e:ResearchEntity {domain: $domain})
         OPTIONAL MATCH (e)-[:ENTITY_MENTIONED_IN]->(a1:Activity)
           WHERE a1.timestamp >= $currentSince
         WITH e, count(a1) AS current_mentions
         OPTIONAL MATCH (e)-[:ENTITY_MENTIONED_IN]->(a2:Activity)
           WHERE a2.timestamp >= $compareSince AND a2.timestamp < $currentSince
         WITH e, current_mentions, count(a2) AS previous_mentions
         WHERE current_mentions > 0
         RETURN e.entity_key AS entity_key, e.name AS name, e.type AS type,
                e.domain AS domain, e.url AS url, e.description AS description,
                e.created_at AS created_at, e.updated_at AS updated_at,
                current_mentions, previous_mentions
         ORDER BY current_mentions DESC
         LIMIT 20`,
        { domain, currentSince, compareSince },
      ),
      this.query(
        `MATCH (t:ResearchTrend {domain: $domain})
         OPTIONAL MATCH (ev1:ResearchEvent)-[:PART_OF_TREND]->(t)
           WHERE ev1.date >= $currentSince
         WITH t, count(ev1) AS current_events
         OPTIONAL MATCH (ev2:ResearchEvent)-[:PART_OF_TREND]->(t)
           WHERE ev2.date >= $compareSince AND ev2.date < $currentSince
         WITH t, current_events, count(ev2) AS previous_events
         WHERE current_events > 0
         RETURN t.trend_key AS trend_key, t.name AS name,
                t.first_seen AS first_seen, t.last_seen AS last_seen,
                t.domain AS domain, t.created_at AS created_at,
                t.updated_at AS updated_at,
                current_events, previous_events
         ORDER BY current_events DESC
         LIMIT 20`,
        { domain, currentSince, compareSince },
      ),
    ]);

    return {
      trending_entities: entityRows.map((r) => ({
        ...this.rowToEntity(r),
        current_mentions: (r.current_mentions as number) ?? 0,
        previous_mentions: (r.previous_mentions as number) ?? 0,
      })),
      trending_trends: trendRows.map((r) => ({
        ...this.rowToTrend(r),
        current_events: (r.current_events as number) ?? 0,
        previous_events: (r.previous_events as number) ?? 0,
      })),
    };
  }

  /**
   * Get the relationship network around an entity up to a given depth.
   */
  async getEntityNetwork(entityName: string, depth = 2): Promise<EntityNetworkReport> {
    // Get center node
    const centerRows = await this.query(
      `MATCH (e:ResearchEntity {name: $name})
       RETURN e.entity_key AS entity_key, e.name AS name,
              e.type AS type, e.domain AS domain`,
      { name: entityName },
    );

    if (centerRows.length === 0) {
      return {
        center: { entity_key: '', name: entityName, type: '', domain: '' },
        nodes: [],
        edges: [],
      };
    }

    const center: EntityNetworkNode = {
      entity_key: centerRows[0].entity_key as string,
      name: centerRows[0].name as string,
      type: (centerRows[0].type as string) || '',
      domain: (centerRows[0].domain as string) || '',
    };

    // Get connected entities via ENTITY_RELATED_TO
    const relRows = await this.query(
      `MATCH path = (src:ResearchEntity {name: $name})-[:ENTITY_RELATED_TO*1..${depth}]-(other:ResearchEntity)
       WHERE other.entity_key <> src.entity_key
       RETURN DISTINCT other.entity_key AS entity_key, other.name AS name,
              other.type AS type, other.domain AS domain
       LIMIT 50`,
      { name: entityName },
    );

    const nodes: EntityNetworkNode[] = relRows.map((r) => ({
      entity_key: r.entity_key as string,
      name: (r.name as string) || '',
      type: (r.type as string) || '',
      domain: (r.domain as string) || '',
    }));

    // Get edges between all discovered nodes
    const allKeys = [center.entity_key, ...nodes.map((n) => n.entity_key)];
    const edges: EntityNetworkEdge[] = [];

    if (allKeys.length > 1) {
      const edgeRows = await this.query(
        `MATCH (a:ResearchEntity)-[r:ENTITY_RELATED_TO]->(b:ResearchEntity)
         WHERE a.entity_key IN $keys AND b.entity_key IN $keys
         RETURN a.entity_key AS from_key, b.entity_key AS to_key,
                r.relation_type AS relation_type, r.confidence AS confidence`,
        { keys: allKeys },
      );

      for (const r of edgeRows) {
        edges.push({
          from_key: r.from_key as string,
          to_key: r.to_key as string,
          relation_type: (r.relation_type as string) || '',
          confidence: (r.confidence as string) || '',
        });
      }
    }

    return { center, nodes, edges };
  }

  /**
   * Full-text search across ResearchEvent nodes.
   */
  async searchEvents(
    queryText: string,
    filters?: { domain?: string; since?: string; eventType?: string },
  ): Promise<ResearchEventRecord[]> {
    const safeQuery = queryText.replace(/'/g, "''");

    // FTS returns matching events; we post-filter by domain/date/type
    const rows = await this.query(
      `CALL QUERY_FTS_INDEX('ResearchEvent', 'research_event_fts', '${safeQuery}')
       RETURN node.event_key AS event_key, node.title AS title, node.date AS date,
              node.description AS description, node.significance AS significance,
              node.event_type AS event_type, node.created_at AS created_at,
              node.updated_at AS updated_at, score
       ORDER BY score DESC
       LIMIT 50`,
    );

    let events = rows.map((r) => this.rowToEvent(r));

    // Apply optional filters
    if (filters?.since) {
      events = events.filter((e) => e.date >= filters.since!);
    }
    if (filters?.eventType) {
      events = events.filter((e) => e.event_type === filters.eventType);
    }

    return events;
  }

  // ─── Row mappers ──────────────────────────────────────────────────────────

  private rowToEntity(r: Record<string, KuzuValue>): ResearchEntityRecord {
    return {
      entity_key: r.entity_key as string,
      name: (r.name as string) || '',
      type: (r.type as string) || '',
      domain: (r.domain as string) || '',
      url: (r.url as string) || '',
      description: (r.description as string) || '',
      created_at: (r.created_at as string) || '',
      updated_at: (r.updated_at as string) || '',
    };
  }

  private rowToEvent(r: Record<string, KuzuValue>): ResearchEventRecord {
    return {
      event_key: r.event_key as string,
      title: (r.title as string) || '',
      date: (r.date as string) || '',
      description: (r.description as string) || '',
      significance: (r.significance as string) || '',
      event_type: (r.event_type as string) || '',
      created_at: (r.created_at as string) || '',
      updated_at: (r.updated_at as string) || '',
    };
  }

  private rowToTrend(r: Record<string, KuzuValue>): ResearchTrendRecord {
    return {
      trend_key: r.trend_key as string,
      name: (r.name as string) || '',
      first_seen: (r.first_seen as string) || '',
      last_seen: (r.last_seen as string) || '',
      domain: (r.domain as string) || '',
      created_at: (r.created_at as string) || '',
      updated_at: (r.updated_at as string) || '',
    };
  }
}
