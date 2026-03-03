import fs from 'fs'
import path from 'path'

// process.cwd() is the ui/ directory in Next.js; .env is one level up
const ENV_PATH = path.join(process.cwd(), '..', '.env')

export function readEnv(): Record<string, string> {
  try {
    const content = fs.readFileSync(ENV_PATH, 'utf-8')
    const result: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIndex = trimmed.indexOf('=')
      if (eqIndex === -1) continue
      const key = trimmed.slice(0, eqIndex).trim()
      const val = trimmed.slice(eqIndex + 1).trim()
      if (key) result[key] = val
    }
    return result
  } catch {
    return {}
  }
}

export function writeEnv(updates: Record<string, string>): void {
  let content = ''
  try {
    content = fs.readFileSync(ENV_PATH, 'utf-8')
  } catch {
    // file doesn't exist yet — start fresh
  }

  const lines = content.split('\n')
  const updatedKeys = new Set<string>()

  // Update existing lines in-place
  const newLines = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) return line
    const key = trimmed.slice(0, eqIndex).trim()
    if (key in updates) {
      updatedKeys.add(key)
      return `${key}=${updates[key]}`
    }
    return line
  })

  // Append any keys not already in the file
  for (const [key, val] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      newLines.push(`${key}=${val}`)
    }
  }

  fs.writeFileSync(ENV_PATH, newLines.join('\n'), 'utf-8')
}

export function maskValue(key: string, val: string): string {
  const upper = key.toUpperCase()
  const sensitive = upper.includes('TOKEN') || upper.includes('PASSWORD') || upper.includes('KEY') || upper.includes('SECRET')
  if (!sensitive) return val
  if (val.length <= 4) return '***'
  return val.slice(0, 4) + '***'
}
