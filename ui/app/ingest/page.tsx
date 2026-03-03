'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

type Status = 'idle' | 'running' | 'done' | 'error'

interface LogLine {
  raw: string
  level?: number
  msg?: string
  time?: string
}

function parseLine(raw: string): LogLine {
  try {
    const obj = JSON.parse(raw)
    return { raw, level: obj.level, msg: obj.msg, time: obj.time }
  } catch {
    return { raw }
  }
}

function LogEntry({ line }: { line: LogLine }) {
  let colorClass = 'text-zinc-400'
  let levelLabel = ''

  if (line.level !== undefined) {
    if (line.level >= 50) {
      colorClass = 'text-red-400'
      levelLabel = '[ERROR] '
    } else if (line.level >= 40) {
      colorClass = 'text-yellow-400'
      levelLabel = '[WARN]  '
    } else {
      colorClass = 'text-zinc-300'
      levelLabel = '[INFO]  '
    }
  }

  const timeStr = line.time ? new Date(line.time).toLocaleTimeString() : ''
  const text = line.msg ?? line.raw

  return (
    <div className={`${colorClass} font-mono text-xs leading-5 whitespace-pre-wrap`}>
      {timeStr && <span className="text-zinc-600 mr-2">{timeStr}</span>}
      {levelLabel && <span className="opacity-60">{levelLabel}</span>}
      {text}
    </div>
  )
}

function StatusBadge({ status }: { status: Status }) {
  const config = {
    idle: { label: 'Idle', classes: 'bg-zinc-700 text-zinc-300' },
    running: { label: 'Running', classes: 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30' },
    done: { label: 'Done', classes: 'bg-green-500/20 text-green-300 border border-green-500/30' },
    error: { label: 'Error', classes: 'bg-red-500/20 text-red-300 border border-red-500/30' },
  }
  const { label, classes } = config[status]
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-medium ${classes}`}>
      {status === 'running' && (
        <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
      )}
      {label}
    </span>
  )
}

export default function IngestPage() {
  const [status, setStatus] = useState<Status>('idle')
  const [lines, setLines] = useState<LogLine[]>([])
  const [finalMsg, setFinalMsg] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)
  const [backfillDays, setBackfillDays] = useState('')
  const logRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  // Auto-scroll to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [lines])

  const startIngestion = useCallback(async () => {
    setLines([])
    setFinalMsg(null)
    setStatus('running')

    try {
      const body = backfillDays ? { backfillDays: parseInt(backfillDays, 10) } : undefined
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) {
        const data = await res.json()
        setFinalMsg({ type: 'error', msg: data.error || 'Failed to start ingestion' })
        setStatus('error')
        return
      }
    } catch (err) {
      setFinalMsg({ type: 'error', msg: String(err) })
      setStatus('error')
      return
    }

    // Connect SSE stream
    if (esRef.current) esRef.current.close()

    const es = new EventSource('/api/ingest')
    esRef.current = es

    es.onmessage = (event) => {
      const data: string = event.data

      // Status signal
      if (data.startsWith('__STATUS__')) {
        const s = data.replace('__STATUS__', '') as Status
        setStatus(s)
        if (s === 'done') {
          setFinalMsg({ type: 'success', msg: 'Ingestion complete' })
        } else if (s === 'error') {
          setFinalMsg({ type: 'error', msg: 'Ingestion finished with errors' })
        }
        es.close()
        return
      }

      try {
        const raw = JSON.parse(data) as string
        setLines((prev) => [...prev, parseLine(raw)])
      } catch {
        setLines((prev) => [...prev, parseLine(data)])
      }
    }

    es.onerror = () => {
      setStatus((prev) => (prev === 'running' ? 'error' : prev))
      setFinalMsg((prev) => prev ?? { type: 'error', msg: 'Connection lost' })
      es.close()
    }
  }, [])

  useEffect(() => {
    return () => {
      esRef.current?.close()
    }
  }, [])

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">Ingest</h1>
        <p className="text-zinc-400 mt-1">Fetch new data from all configured sources</p>
      </div>

      {/* Controls */}
      <div className="flex items-center gap-4">
        <button
          onClick={startIngestion}
          disabled={status === 'running'}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-500 hover:bg-indigo-600 disabled:bg-indigo-500/40 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="6 3 20 12 6 21 6 3" />
          </svg>
          Start Ingestion
        </button>
        <div className="flex items-center gap-2">
          <label htmlFor="backfill-days" className="text-sm text-zinc-400 whitespace-nowrap">
            Backfill days
          </label>
          <input
            id="backfill-days"
            type="number"
            min="1"
            max="365"
            value={backfillDays}
            onChange={(e) => setBackfillDays(e.target.value)}
            placeholder="7"
            disabled={status === 'running'}
            className="w-20 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 text-sm placeholder-zinc-600 focus:outline-none focus:border-indigo-500 disabled:opacity-40"
          />
        </div>
        <StatusBadge status={status} />
      </div>

      {/* Final banner */}
      {finalMsg && (
        <div
          className={`px-4 py-3 rounded-lg text-sm font-medium ${
            finalMsg.type === 'success'
              ? 'bg-green-500/10 border border-green-500/30 text-green-300'
              : 'bg-red-500/10 border border-red-500/30 text-red-300'
          }`}
        >
          {finalMsg.msg}
        </div>
      )}

      {/* Log viewer */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-medium text-zinc-400">Output Log</h2>
          {lines.length > 0 && (
            <span className="text-xs text-zinc-600">{lines.length} lines</span>
          )}
        </div>
        <div
          ref={logRef}
          className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 h-96 overflow-y-auto space-y-0.5"
        >
          {lines.length === 0 ? (
            <p className="text-zinc-600 text-xs font-mono">Waiting for output...</p>
          ) : (
            lines.map((line, i) => <LogEntry key={i} line={line} />)
          )}
        </div>
      </div>
    </div>
  )
}
