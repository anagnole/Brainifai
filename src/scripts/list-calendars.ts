import { createDAVClient } from 'tsdav';

const client = await createDAVClient({
  serverUrl: 'https://caldav.icloud.com',
  credentials: {
    username: process.env.APPLE_CALDAV_USERNAME!,
    password: process.env.APPLE_CALDAV_PASSWORD!,
  },
  authMethod: 'Basic',
  defaultAccountType: 'caldav',
});

const calendars = await client.fetchCalendars();
console.log('\nYour iCloud calendars:\n');
for (const c of calendars) {
  const name = typeof c.displayName === 'string' ? c.displayName : '(unknown)';
  console.log(` • ${name}`);
}
console.log('\nSet APPLE_CALDAV_CALENDARS to a comma-separated subset, or leave empty for all.\n');
