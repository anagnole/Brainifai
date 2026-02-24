import { DEFAULT_BACKFILL_DAYS } from '../../shared/constants.js';

export function getSlackConfig() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error('SLACK_BOT_TOKEN environment variable is required');
  }

  const channelIds = (process.env.SLACK_CHANNEL_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (channelIds.length === 0) {
    throw new Error('SLACK_CHANNEL_IDS environment variable is required (comma-separated)');
  }

  const backfillDays = parseInt(process.env.BACKFILL_DAYS ?? '', 10) || DEFAULT_BACKFILL_DAYS;

  const topicAllowlist = (process.env.TOPIC_ALLOWLIST ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  return { token, channelIds, backfillDays, topicAllowlist };
}
