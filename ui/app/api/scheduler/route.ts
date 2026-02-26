import { NextResponse } from 'next/server'
import { getSchedulerState, toggleScheduler, runIngest } from '@/lib/scheduler'

export async function GET() {
  return NextResponse.json(getSchedulerState())
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))

  if (body.action === 'toggle') {
    toggleScheduler()
  } else if (body.action === 'run_now') {
    // Fire and forget — don't await, let the ingest page SSE handle output
    runIngest()
  }

  return NextResponse.json(getSchedulerState())
}
