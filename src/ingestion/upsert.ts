import type { GraphStore, GraphEdge } from '../graphstore/types.js';
import type { NormalizedMessage } from '../shared/types.js';
import { logger } from '../shared/logger.js';

/**
 * Upsert a batch of normalized messages via GraphStore.
 * Uses upsertNodes + upsertEdges for full idempotency — safe to re-run.
 */
export async function upsertBatch(
  store: GraphStore,
  messages: NormalizedMessage[],
): Promise<void> {
  if (messages.length === 0) return;

  const now = new Date().toISOString();

  // ── Collect unique entities ────────────────────────────────────────────────

  const personsMap = new Map<string, Record<string, unknown>>();
  const containersMap = new Map<string, Record<string, unknown>>();
  const accountsMap = new Map<string, Record<string, unknown>>();
  const activitiesMap = new Map<string, Record<string, unknown>>();
  const topicsMap = new Map<string, Record<string, unknown>>();

  const identifiesEdges: GraphEdge[] = [];
  const ownsEdges: GraphEdge[] = [];
  const fromEdges: GraphEdge[] = [];
  const inEdges: GraphEdge[] = [];
  const mentionsEdges: GraphEdge[] = [];
  const repliesToEdges: GraphEdge[] = [];
  const mentionsPersonEdges: GraphEdge[] = [];

  for (const msg of messages) {
    const pk = msg.person.person_key;
    personsMap.set(pk, {
      person_key: pk,
      display_name: msg.person.display_name,
      source: msg.person.source,
      source_id: msg.person.source_id,
      created_at: now,
      updated_at: now,
    });

    const ck = `${msg.container.source}:${msg.container.container_id}`;
    containersMap.set(ck, {
      source: msg.container.source,
      container_id: msg.container.container_id,
      name: msg.container.name,
      kind: msg.container.kind,
      created_at: now,
      updated_at: now,
    });

    const ak = `${msg.account.source}:${msg.account.account_id}`;
    accountsMap.set(ak, {
      source: msg.account.source,
      account_id: msg.account.account_id,
      linked_person_key: msg.account.linked_person_key,
      created_at: now,
      updated_at: now,
    });

    const actKey = `${msg.activity.source}:${msg.activity.source_id}`;
    if (!activitiesMap.has(actKey)) {
      activitiesMap.set(actKey, {
        source: msg.activity.source,
        source_id: msg.activity.source_id,
        timestamp: msg.activity.timestamp,
        kind: msg.activity.kind,
        snippet: msg.activity.snippet,
        url: msg.activity.url ?? null,
        thread_ts: msg.activity.thread_ts ?? null,
        parent_source_id: msg.activity.parent_source_id ?? null,
        message_count: msg.activity.message_count ?? 0,
        created_at: now,
        updated_at: now,
        valid_from: msg.activity.timestamp,
      });
    }

    for (const topic of msg.topics) {
      topicsMap.set(topic.name, {
        name: topic.name,
        tier: topic.tier ?? 'semantic',
        created_at: now,
        updated_at: now,
      });
    }

    // Edges
    identifiesEdges.push({
      type: 'IDENTIFIES',
      fromLabel: 'SourceAccount',
      toLabel: 'Person',
      from: { source: msg.account.source, account_id: msg.account.account_id },
      to: { person_key: pk },
      properties: { first_seen: now },
    });

    ownsEdges.push({
      type: 'OWNS',
      fromLabel: 'SourceAccount',
      toLabel: 'Activity',
      from: { source: msg.account.source, account_id: msg.account.account_id },
      to: { source: msg.activity.source, source_id: msg.activity.source_id },
      properties: { timestamp: msg.activity.timestamp },
    });

    fromEdges.push({
      type: 'FROM',
      fromLabel: 'Activity',
      toLabel: 'Person',
      from: { source: msg.activity.source, source_id: msg.activity.source_id },
      to: { person_key: pk },
      properties: { timestamp: msg.activity.timestamp },
    });

    inEdges.push({
      type: 'IN',
      fromLabel: 'Activity',
      toLabel: 'Container',
      from: { source: msg.activity.source, source_id: msg.activity.source_id },
      to: { source: msg.container.source, container_id: msg.container.container_id },
      properties: { timestamp: msg.activity.timestamp },
    });

    for (const topic of msg.topics) {
      mentionsEdges.push({
        type: 'MENTIONS',
        fromLabel: 'Activity',
        toLabel: 'Topic',
        from: { source: msg.activity.source, source_id: msg.activity.source_id },
        to: { name: topic.name },
        properties: { timestamp: msg.activity.timestamp },
      });
    }

    // REPLIES_TO edge — only when parent_source_id is set
    if (msg.activity.parent_source_id) {
      repliesToEdges.push({
        type: 'REPLIES_TO',
        fromLabel: 'Activity',
        toLabel: 'Activity',
        from: { source: msg.activity.source, source_id: msg.activity.source_id },
        to: { source_id: msg.activity.parent_source_id },
        properties: { timestamp: msg.activity.timestamp },
      });
    }

    // MENTIONS_PERSON edges — from extracted @mentions
    if (msg.mentions) {
      for (const personKey of msg.mentions) {
        mentionsPersonEdges.push({
          type: 'MENTIONS_PERSON',
          fromLabel: 'Activity',
          toLabel: 'Person',
          from: { source: msg.activity.source, source_id: msg.activity.source_id },
          to: { person_key: personKey },
          properties: { timestamp: msg.activity.timestamp },
        });
      }
    }
  }

  // ── Upsert nodes ──────────────────────────────────────────────────────────

  await store.upsertNodes('Person', [...personsMap.values()], ['person_key']);
  await store.upsertNodes('Container', [...containersMap.values()], ['source', 'container_id']);
  await store.upsertNodes('SourceAccount', [...accountsMap.values()], ['source', 'account_id']);
  await store.upsertNodes('Activity', [...activitiesMap.values()], ['source', 'source_id']);
  await store.upsertNodes('Topic', [...topicsMap.values()], ['name']);

  // ── Upsert edges ──────────────────────────────────────────────────────────

  await store.upsertEdges('IDENTIFIES', identifiesEdges);
  await store.upsertEdges('OWNS', ownsEdges);
  await store.upsertEdges('FROM', fromEdges);
  await store.upsertEdges('IN', inEdges);
  await store.upsertEdges('MENTIONS', mentionsEdges);
  if (repliesToEdges.length > 0) {
    await store.upsertEdges('REPLIES_TO', repliesToEdges);
  }
  if (mentionsPersonEdges.length > 0) {
    await store.upsertEdges('MENTIONS_PERSON', mentionsPersonEdges);
  }

  logger.info({ count: messages.length }, 'Upserted batch');
}
