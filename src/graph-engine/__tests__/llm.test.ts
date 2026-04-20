// Unit tests for extractJson — the only part of llm.ts we can test without
// making real LLM calls. complete() is exercised transitively in integration
// tests (description generation, researcher extract).

import { describe, it, expect } from 'vitest';
import { extractJson, extractJsonOr } from '../llm.js';

describe('extractJson', () => {
  it('parses raw JSON object', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
  });

  it('parses raw JSON array', () => {
    expect(extractJson('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('parses whitespace-padded JSON', () => {
    expect(extractJson('   \n { "a": 1 } \n  ')).toEqual({ a: 1 });
  });

  it('parses markdown-fenced JSON with language tag', () => {
    const input = 'Here is the data:\n```json\n{"a": 1}\n```';
    expect(extractJson(input)).toEqual({ a: 1 });
  });

  it('parses markdown-fenced JSON without language tag', () => {
    const input = '```\n[1,2,3]\n```';
    expect(extractJson(input)).toEqual([1, 2, 3]);
  });

  it('extracts embedded JSON object from commentary', () => {
    const input = 'Sure thing! {"result": true} — hope that helps.';
    expect(extractJson(input)).toEqual({ result: true });
  });

  it('extracts embedded JSON array from commentary', () => {
    const input = 'Here are your entities: [{"name":"Anna"}] done.';
    expect(extractJson(input)).toEqual([{ name: 'Anna' }]);
  });

  it('throws on unparseable input', () => {
    expect(() => extractJson('not json at all')).toThrow(/No valid JSON/);
  });

  it('throws on empty input', () => {
    expect(() => extractJson('')).toThrow(/No valid JSON/);
  });

  it('prefers fenced JSON over embedded when both present', () => {
    const input = 'malformed {a: 1}\n```json\n{"real": true}\n```';
    expect(extractJson(input)).toEqual({ real: true });
  });

  it('handles nested objects', () => {
    const input = '{"a": {"b": [1, {"c": 2}]}}';
    expect(extractJson(input)).toEqual({ a: { b: [1, { c: 2 }] } });
  });

  it('is generic over T (type inference)', () => {
    interface Shape { name: string; count: number }
    const parsed = extractJson<Shape>('{"name":"x","count":3}');
    expect(parsed.name).toBe('x');
    expect(parsed.count).toBe(3);
  });
});

describe('extractJsonOr', () => {
  it('returns parsed value on success', () => {
    expect(extractJsonOr('{"a":1}', { a: 0 })).toEqual({ a: 1 });
  });

  it('returns fallback on failure', () => {
    expect(extractJsonOr('not json', { a: 0 })).toEqual({ a: 0 });
  });

  it('fallback preserves generic type', () => {
    const result = extractJsonOr<{ items: number[] }>('nope', { items: [] });
    expect(result.items).toEqual([]);
  });
});
