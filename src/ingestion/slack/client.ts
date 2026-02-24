import { WebClient } from '@slack/web-api';
import { SLACK_PAGE_SIZE } from '../../shared/constants.js';
import { logger } from '../../shared/logger.js';
import type { SlackMessage, SlackChannel } from './types.js';

let client: WebClient | null = null;

export function getSlackClient(token: string): WebClient {
  if (!client) {
    client = new WebClient(token, {
      retryConfig: { retries: 3 },
    });
  }
  return client;
}

export async function verifyAuth(client: WebClient): Promise<string> {
  const result = await client.auth.test();
  if (!result.ok) throw new Error('Slack auth.test failed');
  logger.info({ team: result.team, user: result.user }, 'Slack auth verified');
  return result.team_id as string;
}

export async function fetchChannelInfo(
  client: WebClient,
  channelId: string,
): Promise<SlackChannel> {
  const result = await client.conversations.info({ channel: channelId });
  const ch = result.channel as any;
  return {
    id: ch.id,
    name: ch.name ?? ch.id,
    is_channel: ch.is_channel ?? true,
  };
}

/**
 * Fetch messages from a channel, paginating automatically.
 * `oldest` is a Slack ts string — only messages after this time are returned.
 */
export async function* fetchChannelHistory(
  client: WebClient,
  channelId: string,
  oldest?: string,
): AsyncGenerator<SlackMessage[]> {
  let cursor: string | undefined;
  do {
    const result = await client.conversations.history({
      channel: channelId,
      oldest,
      limit: SLACK_PAGE_SIZE,
      cursor,
    });

    const messages = (result.messages ?? []) as SlackMessage[];
    if (messages.length > 0) {
      yield messages;
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);
}

export async function getPermalink(
  client: WebClient,
  channelId: string,
  messageTs: string,
): Promise<string | undefined> {
  try {
    const result = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs,
    });
    return result.permalink;
  } catch {
    return undefined;
  }
}
