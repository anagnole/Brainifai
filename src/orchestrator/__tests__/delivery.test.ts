import { describe, it, expect } from 'vitest';
import { toDataPushPayload } from '../delivery.js';
import type { NormalizedMessage } from '../../shared/types.js';

function makeMsg(id: string, opts?: { topics?: string[]; parentSourceId?: string; mentions?: string[] }): NormalizedMessage {
  return {
    activity: {
      source: 'slack',
      source_id: id,
      timestamp: '2026-03-15T10:00:00Z',
      kind: 'message',
      snippet: `Message ${id}`,
      parent_source_id: opts?.parentSourceId,
    },
    person: { person_key: 'slack:U123', display_name: 'Alice', source: 'slack', source_id: 'U123' },
    container: { source: 'slack', container_id: 'C001', name: 'general', kind: 'channel' },
    account: { source: 'slack', account_id: 'U123', linked_person_key: 'slack:U123' },
    topics: (opts?.topics ?? ['testing']).map(t => ({ name: t })),
    mentions: opts?.mentions,
  };
}

describe('toDataPushPayload', () => {
  it('converts a single message to entities and edges', () => {
    const payload = toDataPushPayload([makeMsg('msg1')]);

    // Should have: Person, Activity, Container, SourceAccount, Topic
    expect(payload.entities).toHaveLength(5);
    const kinds = payload.entities.map(e => e.kind);
    expect(kinds).toContain('Person');
    expect(kinds).toContain('Activity');
    expect(kinds).toContain('Container');
    expect(kinds).toContain('SourceAccount');
    expect(kinds).toContain('Topic');

    // Edges: FROM, IN, MENTIONS
    expect(payload.edges).toHaveLength(3);
    const rels = payload.edges!.map(e => e.rel);
    expect(rels).toContain('FROM');
    expect(rels).toContain('IN');
    expect(rels).toContain('MENTIONS');
  });

  it('deduplicates entities across messages', () => {
    // Two messages from the same person, same container, same topic
    const payload = toDataPushPayload([makeMsg('msg1'), makeMsg('msg2')]);

    // Person, Container, SourceAccount, Topic should each appear once; Activity twice
    const personCount = payload.entities.filter(e => e.kind === 'Person').length;
    const activityCount = payload.entities.filter(e => e.kind === 'Activity').length;
    const containerCount = payload.entities.filter(e => e.kind === 'Container').length;
    const topicCount = payload.entities.filter(e => e.kind === 'Topic').length;

    expect(personCount).toBe(1);
    expect(activityCount).toBe(2);
    expect(containerCount).toBe(1);
    expect(topicCount).toBe(1);
  });

  it('includes REPLIES_TO edge for threaded messages', () => {
    const payload = toDataPushPayload([makeMsg('msg1', { parentSourceId: 'parent-1' })]);

    const repliesTo = payload.edges!.filter(e => e.rel === 'REPLIES_TO');
    expect(repliesTo).toHaveLength(1);
    expect(repliesTo[0].to).toBe('parent-1');
  });

  it('includes MENTIONS_PERSON edges for mentions', () => {
    const payload = toDataPushPayload([makeMsg('msg1', { mentions: ['slack:U456', 'slack:U789'] })]);

    const mentionsPerson = payload.edges!.filter(e => e.rel === 'MENTIONS_PERSON');
    expect(mentionsPerson).toHaveLength(2);
  });

  it('handles multiple topics', () => {
    const payload = toDataPushPayload([makeMsg('msg1', { topics: ['react', 'typescript', 'testing'] })]);

    const topicEntities = payload.entities.filter(e => e.kind === 'Topic');
    expect(topicEntities).toHaveLength(3);

    const mentionsEdges = payload.edges!.filter(e => e.rel === 'MENTIONS');
    expect(mentionsEdges).toHaveLength(3);
  });

  it('returns empty arrays for empty input', () => {
    const payload = toDataPushPayload([]);
    expect(payload.entities).toHaveLength(0);
    expect(payload.edges).toHaveLength(0);
  });
});
