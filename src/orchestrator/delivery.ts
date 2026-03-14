import type { NormalizedMessage } from '../shared/types.js';
import type { DataPushData } from '../event-bus/messages.js';
import { emitDataPush } from '../event-bus/helpers.js';
import { logger } from '../shared/logger.js';

/** Convert a batch of NormalizedMessages into DataPushData for event bus delivery */
export function toDataPushPayload(messages: NormalizedMessage[]): DataPushData {
  const entities: DataPushData['entities'] = [];
  const edges: DataPushData['edges'] = [];

  for (const msg of messages) {
    // Person entity
    entities.push({
      kind: 'Person',
      id: msg.person.person_key,
      props: {
        display_name: msg.person.display_name,
        source: msg.person.source,
        source_id: msg.person.source_id,
      },
    });

    // Activity entity
    const activityId = `${msg.activity.source}:${msg.activity.source_id}`;
    entities.push({
      kind: 'Activity',
      id: activityId,
      props: {
        source: msg.activity.source,
        source_id: msg.activity.source_id,
        timestamp: msg.activity.timestamp,
        kind: msg.activity.kind,
        snippet: msg.activity.snippet,
        url: msg.activity.url ?? null,
        thread_ts: msg.activity.thread_ts ?? null,
        parent_source_id: msg.activity.parent_source_id ?? null,
      },
    });

    // Container entity
    const containerId = `${msg.container.source}:${msg.container.container_id}`;
    entities.push({
      kind: 'Container',
      id: containerId,
      props: {
        source: msg.container.source,
        container_id: msg.container.container_id,
        name: msg.container.name,
        kind: msg.container.kind,
      },
    });

    // SourceAccount entity
    entities.push({
      kind: 'SourceAccount',
      id: `${msg.account.source}:${msg.account.account_id}`,
      props: {
        source: msg.account.source,
        account_id: msg.account.account_id,
        linked_person_key: msg.account.linked_person_key,
      },
    });

    // Topic entities
    for (const topic of msg.topics) {
      entities.push({ kind: 'Topic', id: topic.name, props: { name: topic.name } });
    }

    // Edges
    edges!.push({ from: activityId, to: msg.person.person_key, rel: 'FROM' });
    edges!.push({ from: activityId, to: containerId, rel: 'IN' });
    for (const topic of msg.topics) {
      edges!.push({ from: activityId, to: topic.name, rel: 'MENTIONS' });
    }
    if (msg.activity.parent_source_id) {
      edges!.push({ from: activityId, to: msg.activity.parent_source_id, rel: 'REPLIES_TO' });
    }
    if (msg.mentions) {
      for (const personKey of msg.mentions) {
        edges!.push({ from: activityId, to: personKey, rel: 'MENTIONS_PERSON' });
      }
    }
  }

  // Deduplicate entities by kind+id
  const seen = new Set<string>();
  const deduped = entities.filter(e => {
    const key = `${e.kind}:${e.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { entities: deduped, edges };
}

/** Deliver routed messages to a target instance via event bus */
export async function deliverToInstance(
  target: string,
  messages: NormalizedMessage[],
): Promise<void> {
  const payload = toDataPushPayload(messages);
  await emitDataPush('global', target, payload);
  logger.info(
    { target, entityCount: payload.entities.length, edgeCount: payload.edges?.length ?? 0 },
    'Delivered data.push to instance',
  );
}
