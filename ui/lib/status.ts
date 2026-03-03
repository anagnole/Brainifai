import { readFileSync } from 'fs'
import { resolve } from 'path'

export interface StatusData {
  lastRun: string
  lastStatus: 'success' | 'error'
  counts: {
    people: number
    topics: number
    containers: number
    activities: number
  }
  cursors: Array<{
    source: string
    container_id: string
    ts: string
  }>
}

export function readStatus(): StatusData | null {
  try {
    // process.cwd() is ui/ in Next.js; repo root is one level up
    const filePath = resolve(process.cwd(), '..', 'data', 'status.json')
    const raw = readFileSync(filePath, 'utf-8')
    return JSON.parse(raw) as StatusData
  } catch {
    return null
  }
}
