import { MAX_SNIPPET_CHARS } from '../../shared/constants.js';
import type { NormalizedMessage } from '../../shared/types.js';
import type { RawTweet } from './types.js';
import { extractAnnotations } from '../topic-extractor.js';

const TWITTER_MENTION_RE = /@(\w{1,15})/g;

/**
 * Transform a raw tweet into our canonical NormalizedMessage model.
 */
export function normalizeTweet(
  tweet: RawTweet,
  containerName: string,
  containerKind: 'user_timeline' | 'search',
  allowlist: string[],
): NormalizedMessage | null {
  const text = tweet.text;
  if (!text) return null;

  const snippet = text.length > MAX_SNIPPET_CHARS
    ? text.slice(0, MAX_SNIPPET_CHARS) + '\u2026'
    : text;

  const sourceId = `twitter:${containerName}:${tweet.id}`;
  const personKey = `twitter:${tweet.author_id}`;

  const parentSourceId = tweet.in_reply_to_id
    ? `twitter:${containerName}:${tweet.in_reply_to_id}`
    : undefined;

  const annotations = extractAnnotations(text, allowlist);

  // Extract @username mentions from tweet text
  const mentionKeys: string[] = [];
  for (const match of text.matchAll(TWITTER_MENTION_RE)) {
    mentionKeys.push(`twitter:${match[1].toLowerCase()}`);
  }
  // Deduplicate
  const mentions = [...new Set(mentionKeys)];

  // Merge URLs from tweet entities and extracted URLs
  const allUrls = new Set<string>();
  for (const u of tweet.urls ?? []) allUrls.add(u);
  for (const u of annotations.urls) allUrls.add(u);

  const tweetUrl = `https://x.com/${tweet.author_username}/status/${tweet.id}`;

  return {
    activity: {
      source: 'twitter',
      source_id: sourceId,
      timestamp: tweet.created_at,
      kind: 'tweet',
      snippet,
      url: tweetUrl,
      parent_source_id: parentSourceId,
    },
    person: {
      person_key: personKey,
      display_name: tweet.author_display_name,
      source: 'twitter',
      source_id: tweet.author_id,
      avatar_url: tweet.author_avatar_url,
    },
    container: {
      source: 'twitter',
      container_id: containerName,
      name: containerName,
      kind: containerKind,
    },
    account: {
      source: 'twitter',
      account_id: tweet.author_id,
      linked_person_key: personKey,
    },
    topics: annotations.topics.map((name) => ({ name, tier: 'semantic' as const })),
    mentions: mentions.length > 0 ? mentions : undefined,
    urls: allUrls.size > 0 ? [...allUrls] : undefined,
  };
}
