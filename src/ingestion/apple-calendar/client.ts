import { createDAVClient } from 'tsdav';
import { logger } from '../../shared/logger.js';
import type { CalendarEvent, CalendarEventAttendee } from './types.js';

const CALDAV_SERVER = 'https://caldav.icloud.com';
// Fetch up to 30 days into the future so upcoming events are also captured
const FUTURE_DAYS = 30;

async function createClient(username: string, password: string) {
  const client = await createDAVClient({
    serverUrl: CALDAV_SERVER,
    credentials: { username, password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
  logger.info({ username }, 'Apple Calendar CalDAV auth verified');
  return client;
}

// ---------------------------------------------------------------------------
// Minimal iCalendar (RFC 5545) parser
// ---------------------------------------------------------------------------

/** Unfold continuation lines (lines starting with space/tab belong to the previous line) */
function unfold(ics: string): string {
  return ics.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

/** Extract the value of a property, ignoring parameters (e.g. DTSTART;TZID=...:value) */
function getProp(vevent: string, key: string): string | null {
  const match = vevent.match(new RegExp(`^${key}(?:;[^:]*)?:(.*)$`, 'm'));
  return match?.[1]?.trim() ?? null;
}

/** Extract all values of a repeated property (e.g. ATTENDEE) with optional CN param */
function getProps(vevent: string, key: string): CalendarEventAttendee[] {
  const re = new RegExp(`^${key}(?:;[^:]*)?:(.*)$`, 'gm');
  const cnRe = new RegExp(`^${key}(?:.*?CN=([^;:]+))?(?:;[^:]*)?:`, 'm');
  const results: CalendarEventAttendee[] = [];
  for (const match of vevent.matchAll(re)) {
    const raw = match[0];
    const value = match[1].trim();
    const cnMatch = raw.match(cnRe);
    results.push({
      cn: cnMatch?.[1]?.replace(/^"(.*)"$/, '$1') ?? null,
      email: value.replace(/^mailto:/i, ''),
    });
  }
  return results;
}

/** Parse an iCal datetime string to ISO 8601 (treating floating times as UTC) */
export function parseICalDate(value: string): string {
  // Strip VALUE= type params that may appear inline
  const v = value.replace(/^VALUE=DATE-TIME:/i, '').replace(/^VALUE=DATE:/i, '');

  if (v.length === 8) {
    // Date-only: 20241215
    return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`).toISOString();
  }
  // Datetime: 20241215T100000Z or 20241215T100000
  const year = v.slice(0, 4);
  const month = v.slice(4, 6);
  const day = v.slice(6, 8);
  const hour = v.slice(9, 11);
  const min = v.slice(11, 13);
  const sec = v.slice(13, 15);
  return new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}Z`).toISOString();
}

function parseVEvents(icsData: string, calendarName: string, calendarId: string): CalendarEvent[] {
  const unfolded = unfold(icsData);
  const events: CalendarEvent[] = [];

  for (const block of unfolded.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? []) {
    const uid = getProp(block, 'UID');
    const dtstart = getProp(block, 'DTSTART');
    if (!uid || !dtstart) continue;

    const organizers = getProps(block, 'ORGANIZER');

    events.push({
      uid,
      summary: getProp(block, 'SUMMARY') ?? '(No title)',
      description: getProp(block, 'DESCRIPTION'),
      dtstart,
      dtend: getProp(block, 'DTEND'),
      lastModified: getProp(block, 'LAST-MODIFIED'),
      url: getProp(block, 'URL'),
      organizer: organizers[0] ?? null,
      attendees: getProps(block, 'ATTENDEE'),
      calendarName,
      calendarId,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Public fetch API
// ---------------------------------------------------------------------------

export async function fetchCalendarEvents(
  username: string,
  password: string,
  since: string,
  calendarFilter: string[],
): Promise<CalendarEvent[]> {
  const client = await createClient(username, password);
  const calendars = await client.fetchCalendars();

  const davString = (v: string | Record<string, unknown> | undefined): string =>
    typeof v === 'string' ? v : '';

  const filtered = calendarFilter.length > 0
    ? calendars.filter((c) => calendarFilter.includes(davString(c.displayName)))
    : calendars;

  logger.info({ count: filtered.length }, 'Fetching from Apple Calendar calendars');

  const until = new Date(Date.now() + FUTURE_DAYS * 86400 * 1000).toISOString();
  const events: CalendarEvent[] = [];

  for (const calendar of filtered) {
    const calendarName = davString(calendar.displayName) || 'Unknown';
    const calendarId = davString(calendar.url);

    const objects = await client.fetchCalendarObjects({
      calendar,
      timeRange: { start: since, end: until },
    });

    for (const obj of objects) {
      if (!obj.data) continue;
      const parsed = parseVEvents(obj.data, calendarName, calendarId);
      events.push(...parsed);
    }

    logger.info({ calendar: calendarName, events: events.length }, 'Fetched calendar objects');
  }

  return events;
}
