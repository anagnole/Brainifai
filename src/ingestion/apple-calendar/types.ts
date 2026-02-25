export interface CalendarEventAttendee {
  cn: string | null;
  email: string;
}

export interface CalendarEvent {
  uid: string;
  summary: string;
  description: string | null;
  dtstart: string;       // raw iCal datetime string
  dtend: string | null;
  lastModified: string | null;
  url: string | null;
  organizer: CalendarEventAttendee | null;
  attendees: CalendarEventAttendee[];
  calendarName: string;
  calendarId: string;
}
