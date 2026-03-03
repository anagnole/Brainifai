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

  for (const msg of messages) {
    const pk = msg.person.person_key;
    personsMap.set(pk, {
      person_key: pk,
      display_name: msg.person.display_name,
      source: msg.person.source,
      source_id: msg.person.source_id,
    });

    const ck = `${msg.container.source}:${msg.container.container_id}`;
    containersMap.set(ck, {
      source: msg.container.source,
      container_id: msg.container.container_id,
      name: msg.container.name,
      kind: msg.container.kind,
    });

    const ak = `${msg.account.source}:${msg.account.account_id}`;
    accountsMap.set(ak, {
      source: msg.account.source,
      account_id: msg.account.account_id,
      linked_person_key: msg.account.linked_person_key,
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
      });
    }

    for (const topic of msg.topics) {
      topicsMap.set(topic.name, { name: topic.name });
    }

    // Edges
    identifiesEdges.push({
      type: 'IDENTIFIES',
      fromLabel: 'SourceAccount',
      toLabel: 'Person',
      from: { source: msg.account.source, account_id: msg.account.account_id },
      to: { person_key: pk },
    });

    ownsEdges.push({
      type: 'OWNS',
      fromLabel: 'SourceAccount',
      toLabel: 'Activity',
      from: { source: msg.account.source, account_id: msg.account.account_id },
      to: { source: msg.activity.source, source_id: msg.activity.source_id },
    });

    fromEdges.push({
      type: 'FROM',
      fromLabel: 'Activity',
      toLabel: 'Person',
      from: { source: msg.activity.source, source_id: msg.activity.source_id },
      to: { person_key: pk },
    });

    inEdges.push({
      type: 'IN',
      fromLabel: 'Activity',
      toLabel: 'Container',
      from: { source: msg.activity.source, source_id: msg.activity.source_id },
      to: { source: msg.container.source, container_id: msg.container.container_id },
    });

    for (const topic of msg.topics) {
      mentionsEdges.push({
        type: 'MENTIONS',
        fromLabel: 'Activity',
        toLabel: 'Topic',
        from: { source: msg.activity.source, source_id: msg.activity.source_id },
        to: { name: topic.name },
      });
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

  logger.info({ count: messages.length }, 'Upserted batch');
}
