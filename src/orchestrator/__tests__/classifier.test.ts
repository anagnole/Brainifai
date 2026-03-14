import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyBatch } from '../classifier.js';
import type { InstanceContext, OrchestratorConfig } from '../types.js';
import type { NormalizedMessage } from '../../shared/types.js';

function makeMsg(id: string, snippet: string, topics: string[] = []): NormalizedMessage {
  return {
    activity: { source: 'slack', source_id: id, timestamp: '2026-03-15T10:00:00Z', kind: 'message', snippet },
    person: { person_key: 'slack:U123', display_name: 'Alice', source: 'slack', source_id: 'U123' },
    container: { source: 'slack', container_id: 'C001', name: 'general', kind: 'channel' },
    account: { source: 'slack', account_id: 'U123', linked_person_key: 'slack:U123' },
    topics: topics.map(t => ({ name: t })),
  };
}

const instances: InstanceContext[] = [
  { name: 'aballos', type: 'coding', description: 'Online game project with Go backend' },
  { name: 'alfred', type: 'coding', description: 'AI coaching web app with Fastify' },
];

const config: OrchestratorConfig = {
  apiKey: 'test-key',
  model: 'claude-haiku-4-5-20251001',
  batchSize: 20,
  confidenceThreshold: 0.5,
};

describe('classifyBatch', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses valid classifier response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify([
          { index: 0, targets: ['aballos'], confidence: 0.9, reason: 'game-related' },
          { index: 1, targets: ['alfred'], confidence: 0.8, reason: 'coaching' },
        ])}],
      }),
    });

    const result = await classifyBatch(
      [makeMsg('1', 'game update', ['gaming']), makeMsg('2', 'coaching session', ['coaching'])],
      instances,
      config,
    );

    expect(result.results).toHaveLength(2);
    expect(result.results[0].decision.targets).toEqual(['aballos']);
    expect(result.results[1].decision.targets).toEqual(['alfred']);
    expect(result.errors).toHaveLength(0);
  });

  it('falls back to global on API failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    const result = await classifyBatch(
      [makeMsg('1', 'some message')],
      instances,
      config,
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].decision.targets).toEqual([]);
    expect(result.results[0].decision.reason).toContain('global fallback');
  });

  it('falls back to global on network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await classifyBatch(
      [makeMsg('1', 'some message')],
      instances,
      config,
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].decision.targets).toEqual([]);
  });

  it('falls back to global on malformed JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'not valid json at all' }],
      }),
    });

    const result = await classifyBatch(
      [makeMsg('1', 'message')],
      instances,
      config,
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0].decision.targets).toEqual([]);
    expect(result.results[0].decision.reason).toContain('Parse failure');
  });

  it('filters out invalid instance names from targets', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify([
          { index: 0, targets: ['aballos', 'nonexistent'], confidence: 0.9, reason: 'test' },
        ])}],
      }),
    });

    const result = await classifyBatch(
      [makeMsg('1', 'message')],
      instances,
      config,
    );

    expect(result.results[0].decision.targets).toEqual(['aballos']);
  });

  it('applies confidence threshold — low confidence goes to global', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify([
          { index: 0, targets: ['aballos'], confidence: 0.3, reason: 'weak match' },
        ])}],
      }),
    });

    const result = await classifyBatch(
      [makeMsg('1', 'message')],
      instances,
      config,
    );

    // Confidence 0.3 < threshold 0.5 → targets should be empty
    expect(result.results[0].decision.targets).toEqual([]);
    expect(result.results[0].decision.confidence).toBe(0.3);
  });

  it('handles missing indices in classifier output', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify([
          // Only returns index 0, skips index 1
          { index: 0, targets: ['aballos'], confidence: 0.9, reason: 'match' },
        ])}],
      }),
    });

    const result = await classifyBatch(
      [makeMsg('1', 'msg1'), makeMsg('2', 'msg2')],
      instances,
      config,
    );

    expect(result.results).toHaveLength(2);
    expect(result.results[0].decision.targets).toEqual(['aballos']);
    // Missing index falls back to global
    expect(result.results[1].decision.targets).toEqual([]);
    expect(result.results[1].decision.reason).toContain('Missing');
  });

  it('handles JSON wrapped in markdown code blocks', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '```json\n[{"index": 0, "targets": ["alfred"], "confidence": 0.85, "reason": "match"}]\n```' }],
      }),
    });

    const result = await classifyBatch(
      [makeMsg('1', 'message')],
      instances,
      config,
    );

    expect(result.results[0].decision.targets).toEqual(['alfred']);
  });
});
