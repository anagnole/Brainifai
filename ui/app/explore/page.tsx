'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

type EntityType = 'Person' | 'Topic' | 'Container'
type FilterType = 'All' | EntityType

interface Entity {
  id: string
  type: EntityType
  name: string
  score: number
}

interface Activity {
  timestamp: string
  person: string
  channel: string
  kind: string
  snippet: string
  url: string
  source: string
}

const TYPE_COLORS: Record<EntityType, string> = {
  Person: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  Topic: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  Container: 'bg-green-500/20 text-green-300 border-green-500/30',
}

const SOURCE_COLORS: Record<string, string> = {
  slack: 'bg-purple-500/20 text-purple-300',
  github: 'bg-zinc-700 text-zinc-300',
  clickup: 'bg-indigo-500/20 text-indigo-300',
  'apple-calendar': 'bg-green-500/20 text-green-300',
}

function sourceBadgeClass(source: string): string {
  return SOURCE_COLORS[source?.toLowerCase()] ?? 'bg-zinc-700 text-zinc-300'
}

function relativeTime(ts: string): string {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    const diff = Date.now() - d.getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    return `${days}d ago`
  } catch {
    return ts
  }
}

function EntityCard({ entity, onClick, selected }: { entity: Entity; onClick: () => void; selected: boolean }) {
  const colorClass = TYPE_COLORS[entity.type] ?? 'bg-zinc-700 text-zinc-300 border-zinc-600'
  return (
    <button
      onClick={onClick}
      className={`w-full text-left bg-zinc-900 border rounded-xl p-4 hover:border-zinc-600 transition-all ${
        selected ? 'border-indigo-500 ring-1 ring-indigo-500/30' : 'border-zinc-800'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${colorClass}`}>
          {entity.type}
        </span>
      </div>
      <p className="font-medium text-zinc-100 text-sm leading-snug">{entity.name || entity.id}</p>
      <p className="text-xs text-zinc-500 mt-1 font-mono truncate">{entity.id}</p>
    </button>
  )
}

function ActivityItem({ activity }: { activity: Activity }) {
  return (
    <div className="border-b border-zinc-800 pb-3 mb-3 last:border-0 last:mb-0 last:pb-0">
      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${sourceBadgeClass(activity.source)}`}>
          {activity.source}
        </span>
        {activity.kind && (
          <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">
            {activity.kind}
          </span>
        )}
        <span className="text-xs text-zinc-500 ml-auto">{relativeTime(activity.timestamp)}</span>
      </div>
      {activity.snippet && (
        <p className="text-sm text-zinc-300 leading-relaxed line-clamp-3">{activity.snippet}</p>
      )}
      <div className="flex items-center gap-2 mt-1.5 text-xs text-zinc-500">
        {activity.person && <span>{activity.person}</span>}
        {activity.channel && <span>in {activity.channel}</span>}
        {activity.url && (
          <a
            href={activity.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-indigo-400 hover:text-indigo-300"
          >
            Open
          </a>
        )}
      </div>
    </div>
  )
}

const FILTERS: FilterType[] = ['All', 'Person', 'Topic', 'Container']

export default function ExplorePage() {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterType>('All')
  const [results, setResults] = useState<Entity[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Entity | null>(null)
  const [activities, setActivities] = useState<Activity[]>([])
  const [activityLoading, setActivityLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const search = useCallback(async (q: string, type: FilterType) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ q, limit: '24' })
      if (type !== 'All') params.set('type', type)
      const res = await fetch(`/api/entities?${params}`)
      const data = await res.json()
      setResults(data.results ?? [])
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    // No debounce delay when query is empty (initial browse load)
    const delay = query ? 300 : 0
    debounceRef.current = setTimeout(() => {
      search(query, filter)
    }, delay)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, filter, search])

  const fetchActivity = useCallback(async (entity: Entity) => {
    setActivityLoading(true)
    setActivities([])
    try {
      const params = new URLSearchParams({ limit: '20' })
      if (entity.type === 'Person') params.set('person_key', entity.id)
      else if (entity.type === 'Topic') params.set('topic', entity.id)
      else if (entity.type === 'Container') {
        // container_id is the part after the colon
        const parts = entity.id.split(':')
        params.set('container_id', parts.slice(1).join(':') || entity.id)
      }
      const res = await fetch(`/api/activity?${params}`)
      const data = await res.json()
      setActivities(data.activities ?? [])
    } catch {
      setActivities([])
    } finally {
      setActivityLoading(false)
    }
  }, [])

  const handleSelect = (entity: Entity) => {
    setSelected(entity)
    fetchActivity(entity)
  }

  return (
    <div className="flex h-full gap-6">
      {/* Left panel */}
      <div className={`flex flex-col min-w-0 transition-all ${selected ? 'flex-1' : 'w-full'}`}>
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-zinc-100">Explore</h1>
          <p className="text-zinc-400 mt-1">Search people, topics, and containers</p>
        </div>

        {/* Search input */}
        <div className="relative mb-4">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or browse all entities..."
            className="w-full bg-zinc-900 border border-zinc-700 rounded-xl px-4 py-2.5 pl-10 text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
          />
          {loading && (
            <svg
              className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 animate-spin"
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          )}
        </div>

        {/* Filter pills */}
        <div className="flex gap-2 mb-4 flex-wrap">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                filter === f
                  ? 'bg-indigo-500 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        {/* Results grid */}
        {results.length === 0 && !loading && (
          <p className="text-zinc-500 text-sm text-center py-8">No results found</p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 overflow-y-auto">
          {results.map((entity) => (
            <EntityCard
              key={entity.id}
              entity={entity}
              onClick={() => handleSelect(entity)}
              selected={selected?.id === entity.id}
            />
          ))}
        </div>
      </div>

      {/* Right panel (slide-in) */}
      {selected && (
        <div className="w-80 xl:w-96 flex-shrink-0 bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden flex flex-col">
          {/* Panel header */}
          <div className="flex items-start justify-between p-4 border-b border-zinc-800">
            <div>
              <div className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border mb-2 ${TYPE_COLORS[selected.type]}`}>
                {selected.type}
              </div>
              <h2 className="font-semibold text-zinc-100 text-base leading-snug">{selected.name || selected.id}</h2>
              <p className="text-xs text-zinc-500 font-mono mt-0.5 break-all">{selected.id}</p>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-zinc-500 hover:text-zinc-300 flex-shrink-0 ml-2 mt-0.5"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          </div>

          {/* Activity feed */}
          <div className="flex-1 overflow-y-auto p-4">
            <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-3">
              Recent Activity
            </h3>
            {activityLoading && (
              <p className="text-zinc-500 text-xs text-center py-4">Loading...</p>
            )}
            {!activityLoading && activities.length === 0 && (
              <p className="text-zinc-600 text-xs text-center py-4">No recent activity</p>
            )}
            {!activityLoading && activities.map((activity, i) => (
              <ActivityItem key={i} activity={activity} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
