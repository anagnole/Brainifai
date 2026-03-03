/**
 * Backend-agnostic test suite for GraphStore.
 *
 * Runs against Kuzu (embedded, no external deps needed).
 * To test Neo4j, set NEO4J_PASSWORD env var and the test will run against both.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphStore } from '../types.js';
import { KuzuGraphStore } from '../kuzu/adapter.js';
import {
  PERSONS,
  CONTAINERS,
  TOPICS,
  SOURCE_ACCOUNTS,
  ACTIVITIES,
  FROM_EDGES,
  IN_EDGES,
  MENTIONS_EDGES,
  IDENTIFIES_EDGES,
  OWNS_EDGES,
} from './fixtures.js';

function getBackends(): Array<{ name: string; factory: () => GraphStore }> {
  const backends: Array<{ name: string; factory: () => GraphStore }> = [];

  // Kuzu — always available (embedded)
  // Kuzu needs a non-existing path (it creates the directory itself)
  const tmpDir = mkdtempSync(join(tmpdir(), 'kuzu-test-'));
  const dbPath = join(tmpDir, 'test.db');
  backends.push({
    name: 'kuzu',
    factory: () => new KuzuGraphStore({ dbPath }),
  });

  // Neo4j — only if credentials provided
  if (process.env.NEO4J_PASSWORD) {
    // Dynamically import to avoid requiring neo4j-driver for kuzu-only tests
    backends.push({
      name: 'neo4j',
      factory: () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Neo4jGraphStore } = require('../neo4j/adapter.js');
        return new Neo4jGraphStore({
          uri: process.env.NEO4J_URI ?? 'bolt://localhost:7687',
          user: process.env.NEO4J_USER ?? 'neo4j',
          password: process.env.NEO4J_PASSWORD!,
        });
      },
    });
  }

  return backends;
}

const backends = getBackends();

for (const { name, factory } of backends) {
  describe(`GraphStore [${name}]`, () => {
    let store: GraphStore;

    beforeAll(async () => {
      store = factory();
      await store.initialize();

      // Seed test data
      await store.upsertNodes('Person', PERSONS, ['person_key']);
      await store.upsertNodes('Container', CONTAINERS, ['container_id']);
      await store.upsertNodes('Topic', TOPICS, ['name']);
      await store.upsertNodes('SourceAccount', SOURCE_ACCOUNTS, ['account_id']);
      await store.upsertNodes('Activity', ACTIVITIES, ['source_id']);

      await store.upsertEdges('FROM', FROM_EDGES);
      await store.upsertEdges('IN', IN_EDGES);
      await store.upsertEdges('MENTIONS', MENTIONS_EDGES);
      await store.upsertEdges('IDENTIFIES', IDENTIFIES_EDGES);
      await store.upsertEdges('OWNS', OWNS_EDGES);

      // Rebuild FTS after seeding (needed for Kuzu)
      if ('rebuildFtsIndexes' in store) {
        await (store as KuzuGraphStore).rebuildFtsIndexes();
      }
    }, 30_000);

    afterAll(async () => {
      await store.close();
    });

    // ── getNode ────────────────────────────────────────────────────────────

    it('getNode returns a person by key', async () => {
      const node = await store.getNode('Person', { person_key: 'test:alice' });
      expect(node).not.toBeNull();
      expect(node!.label).toBe('Person');
      expect(node!.properties.display_name).toBe('Alice');
    });

    it('getNode returns null for missing key', async () => {
      const node = await store.getNode('Person', { person_key: 'test:nobody' });
      expect(node).toBeNull();
    });

    it('getNode returns a topic', async () => {
      const node = await store.getNode('Topic', { name: 'deploy' });
      expect(node).not.toBeNull();
      expect(node!.properties.name).toBe('deploy');
    });

    // ── findNodes ──────────────────────────────────────────────────────────

    it('findNodes returns filtered results', async () => {
      const nodes = await store.findNodes('Person', { source: 'test' });
      expect(nodes.length).toBe(3);
    });

    it('findNodes respects limit', async () => {
      const nodes = await store.findNodes('Person', { source: 'test' }, { limit: 2 });
      expect(nodes.length).toBe(2);
    });

    // ── search ─────────────────────────────────────────────────────────────

    it('search finds persons by name', async () => {
      const results = await store.search({ query: 'Alice', limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].name).toBe('Alice');
      expect(results[0].type).toBe('Person');
    });

    it('search finds topics', async () => {
      const results = await store.search({ query: 'deploy', limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      const deployResult = results.find((r) => r.name === 'deploy');
      expect(deployResult).toBeDefined();
    });

    it('search respects type filter', async () => {
      const results = await store.search({ query: 'deploy', types: ['Topic'], limit: 5 });
      for (const r of results) {
        expect(r.type).toBe('Topic');
      }
    });

    // ── cursor ─────────────────────────────────────────────────────────────

    it('getCursor returns null initially', async () => {
      const cursor = await store.getCursor('test', 'nonexistent');
      expect(cursor).toBeNull();
    });

    it('setCursor and getCursor round-trip', async () => {
      await store.setCursor('test', 'ch1', '1234567890.000001');
      const cursor = await store.getCursor('test', 'ch1');
      expect(cursor).toBe('1234567890.000001');
    });

    it('setCursor updates existing cursor', async () => {
      await store.setCursor('test', 'ch1', '1234567890.000002');
      const cursor = await store.getCursor('test', 'ch1');
      expect(cursor).toBe('1234567890.000002');
    });

    // ── upsertNodes idempotency ────────────────────────────────────────────

    it('upsertNodes is idempotent', async () => {
      await store.upsertNodes('Person', [PERSONS[0]], ['person_key']);
      const nodes = await store.findNodes('Person', { person_key: 'test:alice' });
      expect(nodes.length).toBe(1);
    });

    // ── timeline ───────────────────────────────────────────────────────────

    it('timeline returns activities for a person', async () => {
      const items = await store.timeline('Person', { person_key: 'test:alice' }, { limit: 10 });
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.actor).toBe('Alice');
      }
    });

    it('timelineMulti deduplicates across roots', async () => {
      const items = await store.timelineMulti(
        [
          { label: 'Person', key: { person_key: 'test:alice' } },
          { label: 'Person', key: { person_key: 'test:bob' } },
        ],
        { limit: 50 },
      );
      // Should have activities from both Alice and Bob
      const actors = new Set(items.map((i) => i.actor));
      expect(actors.has('Alice')).toBe(true);
      expect(actors.has('Bob')).toBe(true);

      // No duplicates by source_id
      const snippets = items.map((i) => i.snippet);
      expect(new Set(snippets).size).toBe(snippets.length);
    });

    // ── getRecentActivity ──────────────────────────────────────────────────

    it('getRecentActivity returns all recent activities', async () => {
      const items = await store.getRecentActivity({ limit: 50 });
      expect(items.length).toBe(5);
    });

    it('getRecentActivity filters by person', async () => {
      const items = await store.getRecentActivity({ personKey: 'test:alice', limit: 50 });
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item.actor).toBe('Alice');
      }
    });

    // ── getEntitySummary ───────────────────────────────────────────────────

    it('getEntitySummary returns summary for a person', async () => {
      const summary = await store.getEntitySummary('test:alice');
      expect(summary).not.toBeNull();
      expect(summary!.name).toBe('Alice');
      expect(summary!.type).toBe('Person');
      expect(summary!.activityCount).toBeGreaterThan(0);
    });

    it('getEntitySummary returns summary for a topic', async () => {
      const summary = await store.getEntitySummary('deploy');
      expect(summary).not.toBeNull();
      expect(summary!.name).toBe('deploy');
      expect(summary!.type).toBe('Topic');
    });

    it('getEntitySummary returns null for unknown entity', async () => {
      const summary = await store.getEntitySummary('nonexistent-entity-xyz');
      expect(summary).toBeNull();
    });

    // ── neighborhood ───────────────────────────────────────────────────────

    it('neighborhood returns connected nodes', async () => {
      const subgraph = await store.neighborhood('Person', { person_key: 'test:alice' });
      expect(subgraph.nodes.length).toBeGreaterThan(0);
      // Should include at least the root node
      const rootNode = subgraph.nodes.find((n) => n.id === 'test:alice');
      expect(rootNode).toBeDefined();
    });

    // ── expand ─────────────────────────────────────────────────────────────

    it('expand returns facts for seeds', async () => {
      const facts = await store.expand([
        { label: 'Person', key: { person_key: 'test:alice' } },
      ]);
      expect(facts.length).toBe(1);
      expect(facts[0].name).toBe('Alice');
      expect(facts[0].activityCount).toBeGreaterThan(0);
    });
  });
}
