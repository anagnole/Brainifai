import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const INTERVAL_MS = 15 * 60 * 1000 // 15 minutes

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

interface SchedulerState {
  enabled: boolean
  running: boolean
  lastRun: string | null
  lastStatus: 'success' | 'error' | null
  nextRun: string | null
  timer: ReturnType<typeof setInterval> | null
}

const state: SchedulerState = {
  enabled: false,
  running: false,
  lastRun: null,
  lastStatus: null,
  nextRun: null,
  timer: null,
}

export function getSchedulerState() {
  return {
    enabled: state.enabled,
    running: state.running,
    lastRun: state.lastRun,
    lastStatus: state.lastStatus,
    nextRun: state.nextRun,
    intervalMinutes: 15,
  }
}

export function startScheduler() {
  if (state.timer) clearInterval(state.timer)
  state.enabled = true
  state.nextRun = new Date(Date.now() + INTERVAL_MS).toISOString()
  state.timer = setInterval(runIngest, INTERVAL_MS)
  console.log('[scheduler] Started — runs every 15 minutes')
}

export function stopScheduler() {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
  state.enabled = false
  state.nextRun = null
  console.log('[scheduler] Stopped')
}

export function toggleScheduler() {
  if (state.enabled) stopScheduler()
  else startScheduler()
}

export async function runIngest(): Promise<void> {
  if (state.running) return

  state.running = true
  state.lastRun = new Date().toISOString()
  if (state.enabled) {
    state.nextRun = new Date(Date.now() + INTERVAL_MS).toISOString()
  }

  console.log('[scheduler] Running ingestion...')

  return new Promise((resolve) => {
    const proc = spawn('npm', ['run', 'ingest'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      shell: true,
    })

    proc.on('close', (code) => {
      state.running = false
      state.lastStatus = code === 0 ? 'success' : 'error'
      console.log(`[scheduler] Ingestion ${state.lastStatus} (exit ${code})`)
      resolve()
    })

    proc.on('error', (err) => {
      state.running = false
      state.lastStatus = 'error'
      console.error('[scheduler] Ingestion error:', err.message)
      resolve()
    })
  })
}
