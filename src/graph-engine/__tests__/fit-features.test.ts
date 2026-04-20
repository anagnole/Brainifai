// Pure unit tests for the synchronous fit features.

import { describe, it, expect } from 'vitest';
import { nameSimilarity, recency, typeMatch } from '../fit-features.js';
import type { Entity } from '../types.js';

function entity(partial: Partial<Entity> = {}): Entity {
  return {
    id: 'e-1',
    name: 'Anna',
    type: 'person',
    first_seen: '2026-01-01T00:00:00.000Z',
    last_seen: '2026-01-01T00:00:00.000Z',
    mention_count: 1,
    aliases: [],
    status: 'active',
    ...partial,
  };
}

describe('nameSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(nameSimilarity('Anna', 'Anna')).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(nameSimilarity('anna', 'Anna')).toBe(1);
  });

  it('gives reasonable score for name overlap', () => {
    // Anna vs Anna Smith: shares 'anna' token
    const score = nameSimilarity('Anna', 'Anna Smith');
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(1);
  });

  it('gives low score for unrelated names', () => {
    expect(nameSimilarity('Anna', 'Robert')).toBeLessThan(0.25);
  });

  it('handles typos via bigram boost', () => {
    // Different tokens post-lowercase (kuzu vs kuzzu), so token jaccard = 0.
    // Bigram overlap carries the similarity signal here.
    const score = nameSimilarity('Kuzu', 'Kuzzu');
    expect(score).toBeGreaterThan(0.15);
    expect(score).toBeLessThan(0.4);
  });

  it('returns 0 for empty strings', () => {
    expect(nameSimilarity('', 'Anna')).toBe(0);
    expect(nameSimilarity('Anna', '')).toBe(0);
  });

  it('handles multi-word matches well', () => {
    expect(nameSimilarity('Claude Code', 'Claude Code CLI')).toBeGreaterThan(0.5);
  });
});

describe('recency', () => {
  it('returns ~1 for seen-now', () => {
    // Tiny sub-ms drift between test setup and recency()'s Date.now() call
    // can shave a hair off 1.0 — any value ≥ 0.99 is correct.
    expect(recency(entity({ last_seen: new Date().toISOString() }))).toBeGreaterThanOrEqual(0.99);
  });

  it('returns ~0 for seen a year ago', () => {
    const yearAgo = new Date(Date.now() - 365 * 86400_000).toISOString();
    const score = recency(entity({ last_seen: yearAgo }));
    expect(score).toBeLessThan(0.05);
  });

  it('returns 0 for older than horizon', () => {
    const twoYearsAgo = new Date(Date.now() - 730 * 86400_000).toISOString();
    expect(recency(entity({ last_seen: twoYearsAgo }))).toBe(0);
  });

  it('returns 0 for unparseable date', () => {
    expect(recency(entity({ last_seen: 'not a date' }))).toBe(0);
  });

  it('decays approximately linearly', () => {
    const mid = new Date(Date.now() - 180 * 86400_000).toISOString();
    const score = recency(entity({ last_seen: mid }));
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.6);
  });
});

describe('typeMatch', () => {
  it('is 1 when types match', () => {
    expect(typeMatch(entity({ type: 'person' }), 'person')).toBe(1);
  });

  it('is 0 when types differ', () => {
    expect(typeMatch(entity({ type: 'person' }), 'project')).toBe(0);
  });
});
