/**
 * Unit tests for LLM extraction (extractFromBatch).
 *
 * Since extraction now uses Claude CLI subprocess, we test:
 * - Empty input handling
 * - Fallback function
 * - Batch size constant
 * - Function signatures
 */
import { describe, it, expect } from 'vitest';
import {
  extractFromBatch,
  fallbackExtraction,
  EXTRACTION_BATCH_SIZE,
} from './extract.js';
import type { NormalizedMessage } from '../../shared/types.js';

function makeActivity(overrides: Partial<NormalizedMessage['activity']> = {}): NormalizedMessage {
  return {
    activity: {
      source: 'twitter',
      source_id: 'twitter:feed:1',
      timestamp: '2025-06-01T12:00:00Z',
      kind: 'tweet',
      snippet: 'OpenAI released GPT-5 with multimodal reasoning capabilities.',
      ...overrides,
    },
    person: {
      person_key: 'twitter:user1',
      display_name: 'User One',
      source: 'twitter',
      source_id: 'user1',
    },
    container: {
      source: 'twitter',
      container_id: 'feed',
      name: 'feed',
      kind: 'user_timeline',
    },
    account: {
      source: 'twitter',
      account_id: 'user1',
      linked_person_key: 'twitter:user1',
    },
    topics: [],
  };
}

describe('extractFromBatch', () => {
  it('returns empty extraction for empty activities without spawning CLI', async () => {
    const result = await extractFromBatch([], 'ai');
    expect(result).toEqual(fallbackExtraction());
  });

  it('accepts two arguments (activities, domain) — no API key needed', () => {
    // Type check: extractFromBatch should accept exactly 2 args
    expect(extractFromBatch.length).toBeLessThanOrEqual(2);
  });

  it('returns a valid ExtractionResult shape', async () => {
    const result = await extractFromBatch([], 'ai');
    expect(result).toHaveProperty('entities');
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('relationships');
    expect(result).toHaveProperty('trends');
    expect(Array.isArray(result.entities)).toBe(true);
    expect(Array.isArray(result.events)).toBe(true);
    expect(Array.isArray(result.relationships)).toBe(true);
    expect(Array.isArray(result.trends)).toBe(true);
  });
});

describe('fallbackExtraction', () => {
  it('returns all empty arrays', () => {
    const result = fallbackExtraction();
    expect(result.entities).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.relationships).toEqual([]);
    expect(result.trends).toEqual([]);
  });
});

describe('EXTRACTION_BATCH_SIZE', () => {
  it('is defined and positive', () => {
    expect(EXTRACTION_BATCH_SIZE).toBeGreaterThan(0);
    expect(EXTRACTION_BATCH_SIZE).toBe(20);
  });
});
