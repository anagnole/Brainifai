import { MAX_SNIPPET_CHARS } from '../shared/constants.js';
import type { NormalizedMessage } from '../shared/types.js';
import type { SlackMessage, SlackChannel } from './slack/types.js';
import { extractTopics } from './topic-extractor.js';

/**
 * Transform a raw Slack message + channel info into our canonical model.
 * Skips bot messages and messages without a user.
 */
export function normalizeSlackMessage(
  msg: SlackMessage,
  channel: SlackChannel,
  allowlist: string[],
  permalink?: string,
): NormalizedMessage | null {
  // Skip bot messages and messages without a user
  if (!msg.user || msg.subtype === 'bot_message' || msg.bot_id) {
    return null;
  }

  const text = msg.text ?? '';
  const snippet = text.length > MAX_SNIPPET_CHARS
    ? text.slice(0, MAX_SNIPPET_CHARS) + '…'
    : text;

  // Convert Slack ts (e.g. "1708012345.000100") to ISO 8601
  const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();

  const sourceId = `slack:${channel.id}:${msg.ts}`;
  const personKey = `slack:${msg.user}`;

  return {
    activity: {
      source: 'slack',
      source_id: sourceId,
      timestamp,
      kind: 'message',
      snippet,
      url: permalink,
      thread_ts: msg.thread_ts,
    },
    person: {
      person_key: personKey,
      display_name: msg.user, // will be enriched later if needed
      source: 'slack',
      source_id: msg.user,
    },
    container: {
      source: 'slack',
      container_id: channel.id,
      name: channel.name,
      kind: 'channel',
    },
    account: {
      source: 'slack',
      account_id: msg.user,
      linked_person_key: personKey,
    },
    topics: extractTopics(text, allowlist).map((name) => ({ name })),
  };
}
