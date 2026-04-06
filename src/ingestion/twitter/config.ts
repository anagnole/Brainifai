import { DEFAULT_BACKFILL_DAYS } from '../../shared/constants.js';

export function getTwitterConfig() {
  const cookies = process.env.TWITTER_COOKIES;
  if (!cookies) {
    throw new Error('TWITTER_COOKIES environment variable is required');
  }

  const usernames = (process.env.TWITTER_USERNAMES ?? '')
    .split(',')
    .map((u) => u.trim().replace(/^@/, ''))
    .filter(Boolean);

  const searchQueries = (process.env.TWITTER_SEARCH_QUERIES ?? '')
    .split(',')
    .map((q) => q.trim())
    .filter(Boolean);

  if (usernames.length === 0 && searchQueries.length === 0) {
    throw new Error(
      'At least one of TWITTER_USERNAMES or TWITTER_SEARCH_QUERIES must be set',
    );
  }

  const backfillDays = parseInt(process.env.BACKFILL_DAYS ?? '', 10) || DEFAULT_BACKFILL_DAYS;

  const topicAllowlist = (process.env.TOPIC_ALLOWLIST ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  return { cookies, usernames, searchQueries, backfillDays, topicAllowlist };
}
