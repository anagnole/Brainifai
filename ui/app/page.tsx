import Link from 'next/link'
import { readEnv } from '@/lib/env'
import { runQuery } from '@/lib/neo4j'

interface Stats {
  people: number
  topics: number
  containers: number
  activities: number
}

interface Cursor {
  source: string
  container_id: string
  ts: string
}

async function getStats(): Promise<Stats> {
  try {
    const [people, topics, containers, activities] = await Promise.all([
      runQuery('MATCH (n:Person) RETURN count(n) AS count'),
      runQuery('MATCH (n:Topic) RETURN count(n) AS count'),
      runQuery('MATCH (n:Container) RETURN count(n) AS count'),
      runQuery('MATCH (n:Activity) RETURN count(n) AS count'),
    ])
    return {
      people: people[0]?.get('count').toNumber() ?? 0,
      topics: topics[0]?.get('count').toNumber() ?? 0,
      containers: containers[0]?.get('count').toNumber() ?? 0,
      activities: activities[0]?.get('count').toNumber() ?? 0,
    }
  } catch {
    return { people: 0, topics: 0, containers: 0, activities: 0 }
  }
}

async function getCursors(): Promise<Cursor[]> {
  try {
    const records = await runQuery(
      'MATCH (cur:Cursor) RETURN cur.source, cur.container_id, cur.ts ORDER BY cur.ts DESC'
    )
    return records.map((r) => ({
      source: r.get('cur.source') ?? '',
      container_id: r.get('cur.container_id') ?? '',
      ts: r.get('cur.ts') ?? '',
    }))
  } catch {
    return []
  }
}

const statCards = [
  {
    key: 'people' as keyof Stats,
    label: 'People',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    key: 'topics' as keyof Stats,
    label: 'Topics',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.04Z" />
        <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.04Z" />
      </svg>
    ),
  },
  {
    key: 'containers' as keyof Stats,
    label: 'Containers',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
        <path d="m3.3 7 8.7 5 8.7-5" />
        <path d="M12 22V12" />
      </svg>
    ),
  },
  {
    key: 'activities' as keyof Stats,
    label: 'Activities',
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
]

const SOURCES = [
  { name: 'Slack', key: 'SLACK_BOT_TOKEN' },
  { name: 'GitHub', key: 'GITHUB_TOKEN' },
  { name: 'ClickUp', key: 'CLICKUP_TOKEN' },
  { name: 'Apple Calendar', key: 'APPLE_CALDAV_PASSWORD' },
  { name: 'Neo4j', key: 'NEO4J_PASSWORD' },
]

function isConfigured(env: Record<string, string>, key: string): boolean {
  const val = env[key] || ''
  return val.length > 0 && !val.includes('your-') && !val.includes('xxxx') && !val.includes('changeme')
}

function formatTs(ts: string): string {
  if (!ts) return '—'
  try {
    // Slack ts format: "1234567890.123456"
    const num = parseFloat(ts)
    if (!isNaN(num) && num > 1000000000) {
      return new Date(num * 1000).toLocaleString()
    }
    return new Date(ts).toLocaleString()
  } catch {
    return ts
  }
}

export default async function DashboardPage() {
  const [stats, cursors, env] = await Promise.all([
    getStats(),
    getCursors(),
    Promise.resolve(readEnv()),
  ])

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">Brainifai</h1>
        <p className="text-zinc-400 mt-1">Personal Knowledge Graph</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <div key={card.key} className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-zinc-400 text-sm font-medium">{card.label}</span>
              <span className="text-indigo-400">{card.icon}</span>
            </div>
            <p className="text-3xl font-bold text-zinc-100">
              {stats[card.key].toLocaleString()}
            </p>
          </div>
        ))}
      </div>

      {/* Sources */}
      <div>
        <h2 className="text-lg font-semibold text-zinc-100 mb-3">Sources</h2>
        <div className="flex flex-wrap gap-2">
          {SOURCES.map((src) => {
            const configured = isConfigured(env, src.key)
            return (
              <span
                key={src.name}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium border ${
                  configured
                    ? 'bg-green-500/10 border-green-500/30 text-green-400'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-500'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${configured ? 'bg-green-400' : 'bg-zinc-600'}`} />
                {src.name}
              </span>
            )
          })}
        </div>
      </div>

      {/* Recent ingestion */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-zinc-100">Recent Ingestion</h2>
          <Link
            href="/ingest"
            className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Run Ingestion
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
            </svg>
          </Link>
        </div>

        {cursors.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 text-center text-zinc-500 text-sm">
            No ingestion history yet. Run your first ingestion to get started.
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800">
                  <th className="text-left px-4 py-3 text-zinc-400 font-medium">Source</th>
                  <th className="text-left px-4 py-3 text-zinc-400 font-medium">Container</th>
                  <th className="text-left px-4 py-3 text-zinc-400 font-medium">Last Cursor</th>
                </tr>
              </thead>
              <tbody>
                {cursors.map((cursor, i) => (
                  <tr key={i} className="border-b border-zinc-800/50 last:border-0 hover:bg-zinc-800/30">
                    <td className="px-4 py-3 text-zinc-300 font-medium">{cursor.source}</td>
                    <td className="px-4 py-3 text-zinc-400 font-mono text-xs">{cursor.container_id}</td>
                    <td className="px-4 py-3 text-zinc-400">{formatTs(cursor.ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
