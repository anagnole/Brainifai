import { DEFAULT_BACKFILL_DAYS } from '../../shared/constants.js';

export function getClickUpConfig() {
  const token = process.env.CLICKUP_TOKEN;
  if (!token) {
    throw new Error('CLICKUP_TOKEN environment variable is required');
  }

  const listIds = (process.env.CLICKUP_LIST_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (listIds.length === 0) {
    throw new Error('CLICKUP_LIST_IDS environment variable is required (comma-separated list IDs)');
  }

  const backfillDays = parseInt(process.env.BACKFILL_DAYS ?? '', 10) || DEFAULT_BACKFILL_DAYS;

  const topicAllowlist = (process.env.TOPIC_ALLOWLIST ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  return { token, listIds, backfillDays, topicAllowlist };
}
