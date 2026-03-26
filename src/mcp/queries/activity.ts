import { getGraphStore } from '../../shared/graphstore.js';
import { truncateEvidence } from '../safety.js';
import { DEFAULT_WINDOW_DAYS } from '../../shared/constants.js';

export interface ActivityItem {
  timestamp: string;
  person: string;
  channel: string;
  kind: string;
  snippet: string;
  url?: string;
  message_count?: number;
}

/**
 * Fetch recent activities with optional filters.
 */
export async function getRecentActivity(opts: {
  personKey?: string;
  topic?: string;
  containerId?: string;
  containerName?: string;
  kinds?: string[];
  windowDays?: number;
  limit?: number;
}): Promise<ActivityItem[]> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const limit = Math.min(opts.limit ?? 20, 50);
  const windowStart = new Date(Date.now() - windowDays * 86400 * 1000).toISOString();

  // Strip source prefix from containerId if present (e.g. "clickup:123" → "123")
  let containerId = opts.containerId;
  if (containerId) {
    const colonIdx = containerId.indexOf(':');
    if (colonIdx > 0) containerId = containerId.slice(colonIdx + 1);
  }

  const store = await getGraphStore();
  const items = await store.getRecentActivity({
    personKey: opts.personKey,
    topic: opts.topic,
    containerId,
    containerName: opts.containerName,
    kinds: opts.kinds,
    since: windowStart,
    limit,
  });

  // Map TimelineItem → ActivityItem (rename actor→person, channel stays)
  const mapped = items.map((i) => ({
    timestamp: i.timestamp,
    person: i.actor,
    channel: i.channel,
    kind: i.kind,
    snippet: i.snippet,
    url: i.url,
    message_count: i.message_count,
  }));

  return truncateEvidence(mapped, limit);
}
