/**
 * Upserts LLM extraction results into the researcher schema.
 *
 * Takes an ExtractionResult and creates/updates ResearchEntity, ResearchEvent,
 * ResearchTrend nodes plus all cross-links (INVOLVED_IN, ENTITY_RELATED_TO,
 * PART_OF_TREND, ENTITY_MENTIONED_IN, EVENT_MENTIONED_IN).
 */

import { logger } from '../../shared/logger.js';
import type { ResearcherGraphStore } from '../../graphstore/kuzu/researcher-adapter.js';
import type { ExtractionResult } from './extract.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Lowercase, replace spaces/underscores with hyphens, strip non-alphanumeric. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Main upsert ─────────────────────────────────────────────────────────────

export async function upsertExtractionResult(
  result: ExtractionResult,
  activitySourceIds: string[],
  domain: string,
  store: ResearcherGraphStore,
): Promise<{ entitiesCount: number; eventsCount: number; trendsCount: number }> {
  const now = new Date().toISOString();
  let entitiesCount = 0;
  let eventsCount = 0;
  let trendsCount = 0;

  // ── Entities ─────────────────────────────────────────────────────────────

  const entityKeyMap = new Map<string, string>(); // name -> entity_key

  for (const entity of result.entities) {
    const entityKey = `${domain}:${slugify(entity.name)}`;
    if (!slugify(entity.name)) continue; // skip empty names
    entityKeyMap.set(entity.name, entityKey);

    try {
      await store.upsertEntity({
        entity_key: entityKey,
        name: entity.name,
        type: entity.type || 'unknown',
        domain,
        url: entity.url ?? '',
        description: entity.description ?? '',
        created_at: now,
        updated_at: now,
      });
      entitiesCount++;
    } catch (err) {
      logger.warn({ err, entity: entity.name }, 'Failed to upsert entity');
    }
  }

  // ── Events ───────────────────────────────────────────────────────────────

  const eventKeyMap = new Map<string, string>(); // title -> event_key

  for (const event of result.events) {
    const eventKey = `${domain}:${event.date}:${slugify(event.title)}`;
    if (!slugify(event.title)) continue;
    eventKeyMap.set(event.title, eventKey);

    try {
      await store.upsertEvent({
        event_key: eventKey,
        title: event.title,
        date: event.date,
        description: event.description || '',
        significance: event.significance || 'medium',
        event_type: event.event_type || 'milestone',
        created_at: now,
        updated_at: now,
      });
      eventsCount++;
    } catch (err) {
      logger.warn({ err, event: event.title }, 'Failed to upsert event');
    }

    // INVOLVED_IN links between entities and this event
    for (const involved of event.involved_entities) {
      const involvedEntityKey = entityKeyMap.get(involved.name);
      if (!involvedEntityKey) continue;

      try {
        await store.linkEntityToEvent(involvedEntityKey, eventKey, involved.role || 'subject');
      } catch (err) {
        logger.warn({ err, entity: involved.name, event: event.title }, 'Failed to link entity to event');
      }
    }
  }

  // ── Trends ───────────────────────────────────────────────────────────────

  for (const trend of result.trends) {
    const trendKey = `${domain}:${slugify(trend.name)}`;
    if (!slugify(trend.name)) continue;

    try {
      await store.upsertTrend({
        trend_key: trendKey,
        name: trend.name,
        first_seen: now,
        last_seen: now,
        domain,
        created_at: now,
        updated_at: now,
      });
      trendsCount++;
    } catch (err) {
      logger.warn({ err, trend: trend.name }, 'Failed to upsert trend');
    }

    // PART_OF_TREND links between events and this trend
    for (const eventTitle of trend.linked_events) {
      const eventKey = eventKeyMap.get(eventTitle);
      if (!eventKey) continue;

      try {
        await store.linkEventToTrend(eventKey, trendKey);
      } catch (err) {
        logger.warn({ err, event: eventTitle, trend: trend.name }, 'Failed to link event to trend');
      }
    }
  }

  // ── Entity relationships ─────────────────────────────────────────────────

  for (const rel of result.relationships) {
    const fromKey = entityKeyMap.get(rel.from_entity);
    const toKey = entityKeyMap.get(rel.to_entity);
    if (!fromKey || !toKey) continue;

    try {
      await store.linkEntityToEntity(fromKey, toKey, rel.relation_type || 'related');
    } catch (err) {
      logger.warn({ err, from: rel.from_entity, to: rel.to_entity }, 'Failed to link entities');
    }
  }

  // ── ENTITY_MENTIONED_IN / EVENT_MENTIONED_IN links to source Activities ─

  for (const sourceId of activitySourceIds) {
    for (const entityKey of Array.from(entityKeyMap.values())) {
      try {
        await store.linkEntityToActivity(entityKey, sourceId, now);
      } catch (err) {
        logger.warn({ err, entityKey, sourceId }, 'Failed to link entity to activity');
      }
    }

    for (const eventKey of Array.from(eventKeyMap.values())) {
      try {
        await store.linkEventToActivity(eventKey, sourceId, now);
      } catch (err) {
        logger.warn({ err, eventKey, sourceId }, 'Failed to link event to activity');
      }
    }
  }

  return { entitiesCount, eventsCount, trendsCount };
}
