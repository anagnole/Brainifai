import { NextRequest, NextResponse } from 'next/server'
import { spawn, ChildProcess } from 'child_process'
import path from 'path'

let activeProcess: ChildProcess | null = null
let logBuffer: string[] = []
let processStatus: 'idle' | 'running' | 'done' | 'error' = 'idle'

export async function POST(req: NextRequest) {
  if (activeProcess) {
    return NextResponse.json({ error: 'Ingestion already running' }, { status: 409 })
  }

  let backfillDays: number | undefined
  try {
    const body = await req.json()
    if (body.backfillDays && Number.isFinite(body.backfillDays)) {
      backfillDays = Math.max(1, Math.min(365, body.backfillDays))
    }
  } catch { /* no body or invalid JSON — use default */ }

  logBuffer = []
  processStatus = 'running'

  const cwd = path.join(process.cwd(), '..')
  const env = { ...process.env, FORCE_COLOR: '0', ...(backfillDays ? { BACKFILL_DAYS: String(backfillDays) } : {}) }

  const child = spawn('npm', ['run', 'ingest'], {
    cwd,
    shell: true,
    env,
  })

  activeProcess = child

  child.stdout.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n')
    for (const line of lines) {
      if (line.trim()) logBuffer.push(line)
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n')
    for (const line of lines) {
      if (line.trim()) logBuffer.push(line)
    }
  })

  child.on('close', (code) => {
    processStatus = code === 0 ? 'done' : 'error'
    activeProcess = null
  })

  child.on('error', (err) => {
    logBuffer.push(`Process error: ${err.message}`)
    processStatus = 'error'
    activeProcess = null
  })

  return NextResponse.json({ ok: true, message: 'Ingestion started' })
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  if (searchParams.get('status')) {
    return NextResponse.json({
      status: processStatus,
      running: activeProcess !== null,
      lines: logBuffer.length,
    })
  }

  let sentIndex = 0

  const stream = new ReadableStream({
    start(controller) {
      // Send all buffered lines immediately
      const sendBuffered = () => {
        while (sentIndex < logBuffer.length) {
          const line = logBuffer[sentIndex++]
          controller.enqueue(`data: ${JSON.stringify(line)}\n\n`)
        }
      }

      sendBuffered()

      const interval = setInterval(() => {
        sendBuffered()

        // If process is done and buffer is drained, close
        if (activeProcess === null && sentIndex >= logBuffer.length) {
          const finalStatus = processStatus
          controller.enqueue(`data: __STATUS__${finalStatus}\n\n`)
          clearInterval(interval)
          controller.close()
        }
      }, 200)

      // Clean up if client disconnects
      req.signal.addEventListener('abort', () => {
        clearInterval(interval)
        try { controller.close() } catch { /* already closed */ }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
