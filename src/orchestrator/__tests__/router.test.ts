import { describe, it, expect } from 'vitest';
import { buildRoutingPlan } from '../router.js';
import type { ClassificationBatch } from '../types.js';
import type { NormalizedMessage } from '../../shared/types.js';

function makeMsg(id: string): NormalizedMessage {
  return {
    activity: { source: 'test', source_id: id, timestamp: new Date().toISOString(), kind: 'message', snippet: `msg ${id}` },
    person: { person_key: `test:user1`, display_name: 'User 1', source: 'test', source_id: 'user1' },
    container: { source: 'test', container_id: 'ch1', name: 'channel-1', kind: 'channel' },
    account: { source: 'test', account_id: 'user1', linked_person_key: 'test:user1' },
    topics: [{ name: 'testing' }],
  };
}

describe('buildRoutingPlan', () => {
  it('routes messages to targeted instances', () => {
    const batch: ClassificationBatch = {
      results: [
        { message: makeMsg('1'), decision: { targets: ['aballos'], confidence: 0.9, reason: 'match' } },
        { message: makeMsg('2'), decision: { targets: ['alfred'], confidence: 0.8, reason: 'match' } },
      ],
      errors: [],
    };

    const plan = buildRoutingPlan(batch);
    expect(plan.targeted.get('aballos')).toHaveLength(1);
    expect(plan.targeted.get('alfred')).toHaveLength(1);
    expect(plan.global).toHaveLength(0);
  });

  it('sends messages with empty targets to global', () => {
    const batch: ClassificationBatch = {
      results: [
        { message: makeMsg('1'), decision: { targets: [], confidence: 0.3, reason: 'no match' } },
      ],
      errors: [],
    };

    const plan = buildRoutingPlan(batch);
    expect(plan.targeted.size).toBe(0);
    expect(plan.global).toHaveLength(1);
  });

  it('handles multi-target fanout', () => {
    const msg = makeMsg('1');
    const batch: ClassificationBatch = {
      results: [
        { message: msg, decision: { targets: ['aballos', 'alfred'], confidence: 0.9, reason: 'both' } },
      ],
      errors: [],
    };

    const plan = buildRoutingPlan(batch);
    expect(plan.targeted.get('aballos')).toHaveLength(1);
    expect(plan.targeted.get('alfred')).toHaveLength(1);
    // Same message reference in both buckets
    expect(plan.targeted.get('aballos')![0]).toBe(msg);
    expect(plan.targeted.get('alfred')![0]).toBe(msg);
    expect(plan.global).toHaveLength(0);
  });

  it('sends error messages to global', () => {
    const batch: ClassificationBatch = {
      results: [],
      errors: [{ message: makeMsg('1'), error: 'API timeout' }],
    };

    const plan = buildRoutingPlan(batch);
    expect(plan.global).toHaveLength(1);
    expect(plan.targeted.size).toBe(0);
  });

  it('handles mixed results: targeted + global + errors', () => {
    const batch: ClassificationBatch = {
      results: [
        { message: makeMsg('1'), decision: { targets: ['aballos'], confidence: 0.9, reason: 'match' } },
        { message: makeMsg('2'), decision: { targets: [], confidence: 0.2, reason: 'no match' } },
      ],
      errors: [{ message: makeMsg('3'), error: 'parse error' }],
    };

    const plan = buildRoutingPlan(batch);
    expect(plan.targeted.get('aballos')).toHaveLength(1);
    expect(plan.global).toHaveLength(2); // 1 no-match + 1 error
  });
});
