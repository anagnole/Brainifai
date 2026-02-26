import { NextResponse } from 'next/server'
import { readEnv } from '@/lib/env'
import { createDAVClient } from 'tsdav'

export async function GET() {
  try {
    const env = readEnv()
    const username = env.APPLE_CALDAV_USERNAME
    const password = env.APPLE_CALDAV_PASSWORD

    if (!username || !password) {
      return NextResponse.json(
        { error: 'APPLE_CALDAV_USERNAME and APPLE_CALDAV_PASSWORD must be set' },
        { status: 400 }
      )
    }

    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username, password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    })

    const calendars = await client.fetchCalendars()
    const result = calendars
      .filter((cal) => cal.displayName)
      .map((cal) => ({ name: cal.displayName as string }))

    return NextResponse.json({ calendars: result })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
