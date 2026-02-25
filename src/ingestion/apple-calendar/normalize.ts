import { MAX_SNIPPET_CHARS } from '../../shared/constants.js';
import { extractTopics } from '../topic-extractor.js';
import type { NormalizedMessage } from '../../shared/types.js';
import { parseICalDate } from './client.js';
import type { CalendarEvent } from './types.js';

function truncate(text: string): string {
  return text.length > MAX_SNIPPET_CHARS ? text.slice(0, MAX_SNIPPET_CHARS) + '…' : text;
}

export function normalizeCalendarEvent(
  event: CalendarEvent,
  calendarOwner: string,
  allowlist: string[],
): NormalizedMessage | null {
  let timestamp: string;
  try {
    timestamp = parseICalDate(event.dtstart);
  } catch {
    return null;
  }

  const text = [event.summary, event.description ?? ''].join('\n');
  const snippet = truncate(text);
  const topics = extractTopics(text, allowlist).map((name) => ({ name }));

  // Use the organizer if available, otherwise fall back to the calendar owner
  const organizerEmail = event.organizer?.email ?? calendarOwner;
  const organizerName = event.organizer?.cn ?? organizerEmail;
  const personKey = `apple-calendar:${organizerEmail}`;

  return {
    activity: {
      source: 'apple-calendar',
      source_id: `apple-calendar:${event.calendarId}:event:${event.uid}`,
      timestamp,
      kind: 'calendar_event',
      snippet,
      url: event.url ?? undefined,
    },
    person: {
      person_key: personKey,
      display_name: organizerName,
      source: 'apple-calendar',
      source_id: organizerEmail,
    },
    container: {
      source: 'apple-calendar',
      container_id: event.calendarId,
      name: event.calendarName,
      kind: 'calendar',
    },
    account: {
      source: 'apple-calendar',
      account_id: organizerEmail,
      linked_person_key: personKey,
    },
    topics,
  };
}
