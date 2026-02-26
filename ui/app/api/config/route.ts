import { NextRequest, NextResponse } from 'next/server'
import { readEnv, writeEnv, maskValue } from '@/lib/env'

export async function GET() {
  try {
    const env = readEnv()
    const vars: Record<string, string> = {}
    for (const [key, val] of Object.entries(env)) {
      vars[key] = maskValue(key, val)
    }
    return NextResponse.json({ vars })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { key: string; value: string }[]
    if (!Array.isArray(body)) {
      return NextResponse.json({ error: 'Expected array' }, { status: 400 })
    }
    const updates: Record<string, string> = {}
    for (const { key, value } of body) {
      if (key) updates[key] = value
    }
    writeEnv(updates)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
