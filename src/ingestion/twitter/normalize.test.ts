/**
 * Unit tests for normalizeTweet().
 */
import { describe, it, expect } from 'vitest';
import { normalizeTweet } from './normalize.js';
import { MAX_SNIPPET_CHARS } from '../../shared/constants.js';
import type { RawTweet } from './types.js';

function makeTweet(overrides: Partial<RawTweet> = {}): RawTweet {
  return {
    id: '1234567890',
    text: 'Hello world from Twitter',
    created_at: '2025-06-01T12:00:00Z',
    author_id: 'U999',
    author_username: 'testuser',
    author_display_name: 'Test User',
    conversation_id: 'conv-1',
    retweet_count: 0,
    like_count: 0,
    reply_count: 0,
    ...overrides,
  };
}

describe('normalizeTweet', () => {
  // ── Basic normalization ──────────────────────────────────────────────────

  it('produces correct source_id format', () => {
    const result = normalizeTweet(makeTweet(), 'mylist', 'user_timeline', []);
    expect(result).not.toBeNull();
    expect(result!.activity.source_id).toBe('twitter:mylist:1234567890');
  });

  it('sets person_key from author_id', () => {
    const result = normalizeTweet(makeTweet(), 'mylist', 'user_timeline', []);
    expect(result!.person.person_key).toBe('twitter:U999');
  });

  it('preserves timestamp and kind', () => {
    const result = normalizeTweet(makeTweet(), 'mylist', 'user_timeline', []);
    expect(result!.activity.timestamp).toBe('2025-06-01T12:00:00Z');
    expect(result!.activity.kind).toBe('tweet');
  });

  it('sets source to twitter for all sub-objects', () => {
    const result = normalizeTweet(makeTweet(), 'mylist', 'user_timeline', []);
    expect(result!.activity.source).toBe('twitter');
    expect(result!.person.source).toBe('twitter');
    expect(result!.container.source).toBe('twitter');
    expect(result!.account.source).toBe('twitter');
  });

  it('builds correct tweet URL', () => {
    const result = normalizeTweet(makeTweet(), 'mylist', 'user_timeline', []);
    expect(result!.activity.url).toBe('https://x.com/testuser/status/1234567890');
  });

  it('sets container fields correctly', () => {
    const result = normalizeTweet(makeTweet(), 'ai_feed', 'search', []);
    expect(result!.container.container_id).toBe('ai_feed');
    expect(result!.container.name).toBe('ai_feed');
    expect(result!.container.kind).toBe('search');
  });

  it('sets account fields correctly', () => {
    const result = normalizeTweet(makeTweet(), 'mylist', 'user_timeline', []);
    expect(result!.account.account_id).toBe('U999');
    expect(result!.account.linked_person_key).toBe('twitter:U999');
  });

  // ── Null returns ─────────────────────────────────────────────────────────

  it('returns null for empty text', () => {
    const result = normalizeTweet(makeTweet({ text: '' }), 'x', 'user_timeline', []);
    expect(result).toBeNull();
  });

  // ── Thread / reply handling ──────────────────────────────────────────────

  it('sets parent_source_id when in_reply_to_id is present', () => {
    const tweet = makeTweet({ in_reply_to_id: '9999' });
    const result = normalizeTweet(tweet, 'mylist', 'user_timeline', []);
    expect(result!.activity.parent_source_id).toBe('twitter:mylist:9999');
  });

  it('leaves parent_source_id undefined when not a reply', () => {
    const result = normalizeTweet(makeTweet(), 'mylist', 'user_timeline', []);
    expect(result!.activity.parent_source_id).toBeUndefined();
  });

  // ── Mention extraction ────────────────────────────────────────────────────

  it('extracts @username mentions as person keys', () => {
    const tweet = makeTweet({ text: 'Hey @Alice and @bob_smith check this out' });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', []);
    expect(result!.mentions).toEqual(
      expect.arrayContaining(['twitter:alice', 'twitter:bob_smith']),
    );
    expect(result!.mentions).toHaveLength(2);
  });

  it('deduplicates repeated mentions', () => {
    const tweet = makeTweet({ text: '@alice says hi @Alice' });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', []);
    expect(result!.mentions).toEqual(['twitter:alice']);
  });

  it('returns undefined mentions when no @-mentions present', () => {
    const tweet = makeTweet({ text: 'No mentions here' });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', []);
    expect(result!.mentions).toBeUndefined();
  });

  // ── Topic extraction via allowlist ────────────────────────────────────────

  it('extracts topics matching allowlist keywords', () => {
    const tweet = makeTweet({ text: 'Excited about Kubernetes and Docker today!' });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', ['kubernetes', 'docker']);
    expect(result!.topics.map((t) => t.name)).toEqual(
      expect.arrayContaining(['kubernetes', 'docker']),
    );
  });

  it('extracts hashtags as topics', () => {
    const tweet = makeTweet({ text: 'Working on #machinelearning and #AI' });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', []);
    expect(result!.topics.map((t) => t.name)).toEqual(
      expect.arrayContaining(['machinelearning']),
    );
  });

  it('sets topic tier to semantic', () => {
    const tweet = makeTweet({ text: 'Check out #rust' });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', []);
    for (const t of result!.topics) {
      expect(t.tier).toBe('semantic');
    }
  });

  // ── Snippet truncation ────────────────────────────────────────────────────

  it('truncates long text at MAX_SNIPPET_CHARS with ellipsis', () => {
    const longText = 'A'.repeat(MAX_SNIPPET_CHARS + 500);
    const tweet = makeTweet({ text: longText });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', []);
    expect(result!.activity.snippet.length).toBe(MAX_SNIPPET_CHARS + 1); // +1 for ellipsis char
    expect(result!.activity.snippet.endsWith('\u2026')).toBe(true);
  });

  it('does not truncate short text', () => {
    const tweet = makeTweet({ text: 'Short tweet' });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', []);
    expect(result!.activity.snippet).toBe('Short tweet');
  });

  // ── URL extraction ────────────────────────────────────────────────────────

  it('includes URLs from tweet entities', () => {
    const tweet = makeTweet({
      text: 'Check this out',
      urls: ['https://example.com'],
    });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', []);
    expect(result!.urls).toContain('https://example.com');
  });

  it('extracts URLs from tweet text', () => {
    const tweet = makeTweet({
      text: 'Read this: https://news.example.com/article',
    });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', []);
    expect(result!.urls).toContain('https://news.example.com/article');
  });

  it('deduplicates URLs from entities and text', () => {
    const tweet = makeTweet({
      text: 'Link: https://example.com',
      urls: ['https://example.com'],
    });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', []);
    expect(result!.urls).toEqual(['https://example.com']);
  });

  it('returns undefined urls when no URLs present', () => {
    const tweet = makeTweet({ text: 'No links', urls: [] });
    const result = normalizeTweet(tweet, 'x', 'user_timeline', []);
    expect(result!.urls).toBeUndefined();
  });
});
