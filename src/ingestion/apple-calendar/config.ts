import { DEFAULT_BACKFILL_DAYS } from '../../shared/constants.js';

export function getAppleCalendarConfig() {
  const username = process.env.APPLE_CALDAV_USERNAME;
  if (!username) throw new Error('APPLE_CALDAV_USERNAME environment variable is required');

  const password = process.env.APPLE_CALDAV_PASSWORD;
  if (!password) throw new Error('APPLE_CALDAV_PASSWORD environment variable is required (use an app-specific password)');

  const backfillDays = parseInt(process.env.BACKFILL_DAYS ?? '', 10) || DEFAULT_BACKFILL_DAYS;

  // Optional: comma-separated calendar display names to include (empty = all)
  const calendarFilter = (process.env.APPLE_CALDAV_CALENDARS ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const topicAllowlist = (process.env.TOPIC_ALLOWLIST ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  return { username, password, backfillDays, calendarFilter, topicAllowlist };
}
