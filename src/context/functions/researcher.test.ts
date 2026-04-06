/**
 * Tests for researcher context functions.
 *
 * Verifies that each function has the correct name, description, and schema.
 * Integration tests with a real Kuzu DB are avoided here since the functions
 * use withResearcherStore which resolves a real instance DB path. The adapter
 * query methods are tested separately in researcher-schema.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  getLandscapeFn,
  getEntityTimelineFn,
  getTrendingFn,
  getEntityNetworkFn,
  searchEventsFn,
} from './researcher.js';
import type { ContextFunction } from '../types.js';

/** All 5 researcher context functions. */
const ALL_FUNCTIONS: ContextFunction[] = [
  getLandscapeFn,
  getEntityTimelineFn,
  getTrendingFn,
  getEntityNetworkFn,
  searchEventsFn,
];

describe('Researcher Context Functions', () => {
  // ── Registration metadata ───────────────────────────────────────────────

  it('exports exactly 5 context functions', () => {
    expect(ALL_FUNCTIONS).toHaveLength(5);
  });

  it('all functions have unique names', () => {
    const names = ALL_FUNCTIONS.map((fn) => fn.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all functions have non-empty descriptions', () => {
    for (const fn of ALL_FUNCTIONS) {
      expect(fn.description.length).toBeGreaterThan(10);
    }
  });

  it('all functions have an execute method', () => {
    for (const fn of ALL_FUNCTIONS) {
      expect(typeof fn.execute).toBe('function');
    }
  });

  it('all functions have a schema with at least one field', () => {
    for (const fn of ALL_FUNCTIONS) {
      expect(Object.keys(fn.schema).length).toBeGreaterThan(0);
      for (const value of Object.values(fn.schema)) {
        expect(value).toBeInstanceOf(z.ZodType);
      }
    }
  });

  // ── get_landscape ──────────────────────────────────────────────────────────

  describe('get_landscape', () => {
    it('has the correct name', () => {
      expect(getLandscapeFn.name).toBe('get_landscape');
    });

    it('schema includes domain, days, and limit', () => {
      expect(getLandscapeFn.schema).toHaveProperty('domain');
      expect(getLandscapeFn.schema).toHaveProperty('days');
      expect(getLandscapeFn.schema).toHaveProperty('limit');
    });

    it('domain is a required string', () => {
      const result = getLandscapeFn.schema.domain.safeParse('ai');
      expect(result.success).toBe(true);

      const badResult = getLandscapeFn.schema.domain.safeParse(123);
      expect(badResult.success).toBe(false);
    });
  });

  // ── get_entity_timeline ────────────────────────────────────────────────────

  describe('get_entity_timeline', () => {
    it('has the correct name', () => {
      expect(getEntityTimelineFn.name).toBe('get_entity_timeline');
    });

    it('schema includes entity_name and limit', () => {
      expect(getEntityTimelineFn.schema).toHaveProperty('entity_name');
      expect(getEntityTimelineFn.schema).toHaveProperty('limit');
    });

    it('entity_name is a required string', () => {
      const result = getEntityTimelineFn.schema.entity_name.safeParse('OpenAI');
      expect(result.success).toBe(true);
    });
  });

  // ── get_trending ──────────────────────────────────────────────────────────

  describe('get_trending', () => {
    it('has the correct name', () => {
      expect(getTrendingFn.name).toBe('get_trending');
    });

    it('schema includes domain, current_days, and compare_days', () => {
      expect(getTrendingFn.schema).toHaveProperty('domain');
      expect(getTrendingFn.schema).toHaveProperty('current_days');
      expect(getTrendingFn.schema).toHaveProperty('compare_days');
    });
  });

  // ── get_entity_network ────────────────────────────────────────────────────

  describe('get_entity_network', () => {
    it('has the correct name', () => {
      expect(getEntityNetworkFn.name).toBe('get_entity_network');
    });

    it('schema includes entity_name and depth', () => {
      expect(getEntityNetworkFn.schema).toHaveProperty('entity_name');
      expect(getEntityNetworkFn.schema).toHaveProperty('depth');
    });

    it('depth has max constraint of 2', () => {
      const result = getEntityNetworkFn.schema.depth.safeParse(3);
      expect(result.success).toBe(false);

      const validResult = getEntityNetworkFn.schema.depth.safeParse(2);
      expect(validResult.success).toBe(true);
    });
  });

  // ── search_events ─────────────────────────────────────────────────────────

  describe('search_events', () => {
    it('has the correct name', () => {
      expect(searchEventsFn.name).toBe('search_events');
    });

    it('schema includes query, domain, event_type, and limit', () => {
      expect(searchEventsFn.schema).toHaveProperty('query');
      expect(searchEventsFn.schema).toHaveProperty('domain');
      expect(searchEventsFn.schema).toHaveProperty('event_type');
      expect(searchEventsFn.schema).toHaveProperty('limit');
    });

    it('query is a required string', () => {
      const result = searchEventsFn.schema.query.safeParse('GPT-5');
      expect(result.success).toBe(true);
    });

    it('domain and event_type are optional', () => {
      const domainResult = searchEventsFn.schema.domain.safeParse(undefined);
      expect(domainResult.success).toBe(true);

      const eventTypeResult = searchEventsFn.schema.event_type.safeParse(undefined);
      expect(eventTypeResult.success).toBe(true);
    });
  });
});
