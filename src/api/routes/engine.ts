// ─── Engine viz API ─────────────────────────────────────────────────────────
// Routes that expose the new graph-engine schema (Atom / Entity / Episode +
// MENTIONS / ASSOCIATED / IN_EPISODE edges) to the React dashboard.
//
// Default DB: $BRAINIFAI_ENGINE_DB, else ~/.brainifai/global/data/kuzu.
// Override at runtime via `?dbPath=` query param.

import type { FastifyPluginAsync } from 'fastify';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { getEngine } from '../../graph-engine/singleton.js';
import { generalSpec } from '../../instances/general/schema.js';
import { resolveCueToSeeds } from '../../graph-engine/entities.js';
import { spreadActivation } from '../../graph-engine/reads.js';

const DEFAULT_DB = process.env.BRAINIFAI_ENGINE_DB
  ?? resolve(homedir(), '.brainifai', 'global', 'data', 'kuzu');

const LONGFORM_DB = '/tmp/brainifai-longform/kuzu';

/** Pick the first DB path that exists. */
function pickDefaultDbPath(): string {
  if (existsSync(DEFAULT_DB)) return DEFAULT_DB;
  if (existsSync(LONGFORM_DB)) return LONGFORM_DB;
  return DEFAULT_DB; // caller will get an error opening it — that's informative
}

async function getEngineFor(dbPath?: string) {
  return getEngine(dbPath ?? pickDefaultDbPath(), generalSpec);
}

async function allRows<T>(conn: any, cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  if (Object.keys(params).length > 0) {
    const ps = await conn.prepare(cypher);
    const result = await conn.execute(ps, params);
    return (Array.isArray(result) ? result[0] : result).getAll();
  }
  const result = await conn.query(cypher);
  return (Array.isArray(result) ? result[0] : result).getAll();
}

export const engineRoute: FastifyPluginAsync = async (app) => {
  // ─── Overview: counts + top entities + recent atoms ─────────────────────
  app.get<{ Querystring: { dbPath?: string } }>('/engine/overview', async (req) => {
    const engine = await getEngineFor(req.query.dbPath);
    const conn = engine.getConnection();

    const [atoms, entities, eps, mentions, assocs] = await Promise.all([
      allRows<{ c: number | bigint }>(conn, `MATCH (a:Atom) RETURN count(a) AS c`),
      allRows<{ c: number | bigint }>(conn, `MATCH (e:Entity) RETURN count(e) AS c`),
      allRows<{ c: number | bigint }>(conn, `MATCH (ep:Episode) RETURN count(ep) AS c`),
      allRows<{ c: number | bigint }>(conn, `MATCH (:Atom)-[r:MENTIONS]->(:Entity) RETURN count(r) AS c`),
      allRows<{ c: number | bigint }>(conn, `MATCH (:Entity)-[r:ASSOCIATED]->(:Entity) RETURN count(r) AS c`),
    ]);

    const topEntities = await allRows<{ id: string; name: string; type: string; mc: number | bigint }>(
      conn,
      `MATCH (e:Entity) RETURN e.id AS id, e.name AS name, e.type AS type, e.mention_count AS mc
       ORDER BY mc DESC LIMIT 15`,
    );

    const recentAtoms = await allRows<{ id: string; content: string; kind: string; created_at: string; cwd: string }>(
      conn,
      `MATCH (a:Atom) RETURN a.id AS id, a.content AS content, a.kind AS kind,
              a.created_at AS created_at, a.cwd AS cwd
       ORDER BY a.created_at DESC LIMIT 15`,
    );

    return {
      dbPath: engine.dbPath,
      counts: {
        atoms: Number(atoms[0]?.c ?? 0),
        entities: Number(entities[0]?.c ?? 0),
        episodes: Number(eps[0]?.c ?? 0),
        mentions: Number(mentions[0]?.c ?? 0),
        associations: Number(assocs[0]?.c ?? 0),
      },
      topEntities: topEntities.map((r) => ({
        id: r.id, name: r.name, type: r.type, mentionCount: Number(r.mc),
      })),
      recentAtoms,
    };
  });

  // ─── Search: resolveCueToSeeds + return ranked seeds ────────────────────
  app.get<{ Querystring: { q?: string; dbPath?: string } }>('/engine/search', async (req, reply) => {
    const q = (req.query.q ?? '').trim();
    if (!q) return reply.status(400).send({ error: 'q required' });
    const engine = await getEngineFor(req.query.dbPath);
    const seeds = await resolveCueToSeeds(engine.getConnection(), engine.spec, q, 10, engine);
    return seeds.map((s) => ({
      id: s.entity.id,
      name: s.entity.name,
      type: s.entity.type,
      mentionCount: s.entity.mention_count,
      confidence: s.confidence,
    }));
  });

  // ─── Atom details ────────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { dbPath?: string } }>('/engine/atom/:id', async (req, reply) => {
    const engine = await getEngineFor(req.query.dbPath);
    const conn = engine.getConnection();

    const atoms = await allRows<Record<string, unknown>>(conn, `
      MATCH (a:Atom {id: $id})
      RETURN a.id AS id, a.content AS content, a.kind AS kind, a.salience AS salience,
             a.created_at AS created_at, a.last_accessed AS last_accessed,
             a.access_count AS access_count, a.source_instance AS source_instance,
             a.cwd AS cwd, a.source_kind AS source_kind, a.tier AS tier,
             a.extracted AS extracted, a.superseded_by AS superseded_by
    `, { id: req.params.id });
    if (atoms.length === 0) return reply.status(404).send({ error: 'not found' });

    const mentions = await allRows(conn, `
      MATCH (:Atom {id: $id})-[r:MENTIONS]->(e:Entity)
      RETURN e.id AS id, e.name AS name, e.type AS type, r.prominence AS prominence
      ORDER BY prominence DESC
    `, { id: req.params.id });

    const episode = await allRows(conn, `
      MATCH (:Atom {id: $id})-[:IN_EPISODE]->(ep:Episode)
      RETURN ep.id AS id, ep.start_time AS start_time, ep.cwd AS cwd
    `, { id: req.params.id });

    return { atom: atoms[0], mentions, episode: episode[0] ?? null };
  });

  // ─── Entity details ──────────────────────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { dbPath?: string; limit?: string } }>(
    '/engine/entity/:id',
    async (req, reply) => {
      const engine = await getEngineFor(req.query.dbPath);
      const conn = engine.getConnection();
      const limit = Number(req.query.limit ?? '20');

      const entities = await allRows<Record<string, unknown>>(conn, `
        MATCH (e:Entity {id: $id})
        RETURN e.id AS id, e.name AS name, e.type AS type,
               e.first_seen AS first_seen, e.last_seen AS last_seen,
               e.mention_count AS mention_count, e.status AS status
      `, { id: req.params.id });
      if (entities.length === 0) return reply.status(404).send({ error: 'not found' });

      const mentioningAtoms = await allRows(conn, `
        MATCH (a:Atom)-[r:MENTIONS]->(e:Entity {id: $id})
        RETURN a.id AS id, a.content AS content, a.kind AS kind,
               a.created_at AS created_at, r.prominence AS prominence
        ORDER BY a.created_at DESC LIMIT $limit
      `, { id: req.params.id, limit });

      const associations = await allRows(conn, `
        MATCH (e:Entity {id: $id})-[r:ASSOCIATED]-(o:Entity)
        RETURN o.id AS id, o.name AS name, o.type AS type, r.weight AS weight
        ORDER BY weight DESC LIMIT 15
      `, { id: req.params.id });

      return { entity: entities[0], mentioningAtoms, associations };
    },
  );

  // ─── Neighborhood subgraph for Sigma ─────────────────────────────────────
  app.get<{ Params: { id: string }; Querystring: { dbPath?: string; hops?: string } }>(
    '/engine/neighborhood/:id',
    async (req) => {
      const engine = await getEngineFor(req.query.dbPath);
      const conn = engine.getConnection();
      const hops = Math.min(Number(req.query.hops ?? '1'), 2) as 1 | 2;

      // Spread activation gives us weighted neighbors + preserves the seed.
      const activated = await spreadActivation(engine, {
        seeds: [{ entityId: req.params.id, score: 1.0 }],
        hops,
        decay: 0.5,
        topK: 30,
      });
      const ids = activated.map((a) => a.entityId);

      // Fetch entity rows + edges between them.
      const nodes = await allRows<{ id: string; name: string; type: string }>(conn, `
        MATCH (e:Entity) WHERE e.id IN $ids
        RETURN e.id AS id, e.name AS name, e.type AS type
      `, { ids });

      const edges = await allRows<{ source: string; target: string; weight: number | bigint }>(conn, `
        MATCH (a:Entity)-[r:ASSOCIATED]->(b:Entity)
        WHERE a.id IN $ids AND b.id IN $ids
        RETURN a.id AS source, b.id AS target, r.weight AS weight
      `, { ids });

      return {
        nodes: nodes.map((n) => {
          const activation = activated.find((a) => a.entityId === n.id)?.score ?? 0;
          return { id: n.id, name: n.name, type: n.type, activation };
        }),
        edges: edges.map((e) => ({
          source: e.source, target: e.target, weight: Number(e.weight),
        })),
      };
    },
  );

  // ─── Episode list ────────────────────────────────────────────────────────
  app.get<{ Querystring: { dbPath?: string; limit?: string } }>('/engine/episodes', async (req) => {
    const engine = await getEngineFor(req.query.dbPath);
    const limit = Number(req.query.limit ?? '20');
    const rows = await allRows(engine.getConnection(), `
      MATCH (ep:Episode)
      OPTIONAL MATCH (a:Atom)-[:IN_EPISODE]->(ep)
      RETURN ep.id AS id, ep.start_time AS start_time, ep.end_time AS end_time,
             ep.cwd AS cwd, ep.source_instance AS source_instance,
             ep.closed AS closed, count(a) AS atom_count
      ORDER BY ep.start_time DESC LIMIT $limit
    `, { limit });
    return rows.map((r: any) => ({
      id: r.id, start_time: r.start_time, end_time: r.end_time, cwd: r.cwd,
      source_instance: r.source_instance, closed: Boolean(r.closed), atomCount: Number(r.atom_count),
    }));
  });
};
