'use client'

import { useState, useEffect, useCallback } from 'react'

interface SourceField {
  key: string
  label: string
  type?: 'text' | 'password' | 'textarea'
  placeholder?: string
}

interface SourceDef {
  id: string
  name: string
  fields: SourceField[]
}

type EnvVars = Record<string, string>

function EyeIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    )
  }
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  )
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: SourceField
  value: string
  onChange: (key: string, val: string) => void
}) {
  const [shown, setShown] = useState(false)
  const isSensitive = field.type === 'password'

  if (field.type === 'textarea') {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(field.key, e.target.value)}
        placeholder={field.placeholder}
        rows={2}
        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 text-sm placeholder-zinc-600 focus:outline-none focus:border-indigo-500 resize-none font-mono"
      />
    )
  }

  return (
    <div className="relative">
      <input
        type={isSensitive && !shown ? 'password' : 'text'}
        value={value}
        onChange={(e) => onChange(field.key, e.target.value)}
        placeholder={field.placeholder}
        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 pr-9 text-zinc-100 text-sm placeholder-zinc-600 focus:outline-none focus:border-indigo-500"
      />
      {isSensitive && (
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
        >
          <EyeIcon open={shown} />
        </button>
      )}
    </div>
  )
}

function SourceCard({
  source,
  vars,
  onSave,
  onCalendarFetch,
}: {
  source: SourceDef
  vars: EnvVars
  onSave: (fields: SourceField[], localVars: EnvVars) => Promise<void>
  onCalendarFetch?: (setVar: (key: string, val: string) => void) => void
}) {
  const [open, setOpen] = useState(false)
  const [localVars, setLocalVars] = useState<EnvVars>({})

  useEffect(() => {
    const init: EnvVars = {}
    for (const f of source.fields) {
      init[f.key] = vars[f.key] || ''
    }
    setLocalVars(init)
  }, [vars, source.fields])

  const handleChange = (key: string, val: string) => {
    setLocalVars((prev) => ({ ...prev, [key]: val }))
  }

  const setVar = (key: string, val: string) => {
    setLocalVars((prev) => ({ ...prev, [key]: val }))
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-zinc-800/50 transition-colors"
      >
        <span className="font-medium text-zinc-100">{source.name}</span>
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
          className={`transition-transform text-zinc-400 ${open ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="px-5 pb-5 border-t border-zinc-800 pt-4 space-y-4">
          {source.fields.map((field) => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-zinc-400 mb-1.5">
                {field.label}
                <span className="ml-2 text-xs text-zinc-600 font-mono">{field.key}</span>
              </label>
              <FieldInput field={field} value={localVars[field.key] || ''} onChange={handleChange} />
            </div>
          ))}

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => onSave(source.fields, localVars)}
              className="px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Save
            </button>
            {onCalendarFetch && (
              <button
                type="button"
                onClick={() => onCalendarFetch(setVar)}
                className="text-sm text-indigo-400 hover:text-indigo-300 underline"
              >
                List Calendars
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const SOURCES: SourceDef[] = [
  {
    id: 'neo4j',
    name: 'Neo4j',
    fields: [
      { key: 'NEO4J_URI', label: 'URI', placeholder: 'bolt://localhost:7687' },
      { key: 'NEO4J_USER', label: 'Username', placeholder: 'neo4j' },
      { key: 'NEO4J_PASSWORD', label: 'Password', type: 'password', placeholder: '••••••••' },
    ],
  },
  {
    id: 'slack',
    name: 'Slack',
    fields: [
      { key: 'SLACK_BOT_TOKEN', label: 'Bot Token', type: 'password', placeholder: 'xoxb-...' },
      { key: 'SLACK_CHANNEL_IDS', label: 'Channel IDs', type: 'textarea', placeholder: 'C01ABCDEF,C02GHIJKL' },
    ],
  },
  {
    id: 'github',
    name: 'GitHub',
    fields: [
      { key: 'GITHUB_TOKEN', label: 'Personal Access Token', type: 'password', placeholder: 'ghp_...' },
      { key: 'GITHUB_REPOS', label: 'Repositories', type: 'textarea', placeholder: 'owner/repo,owner/repo2' },
    ],
  },
  {
    id: 'clickup',
    name: 'ClickUp',
    fields: [
      { key: 'CLICKUP_TOKEN', label: 'API Token', type: 'password', placeholder: 'pk_...' },
      { key: 'CLICKUP_LIST_IDS', label: 'List IDs', type: 'textarea', placeholder: 'abc123,def456' },
    ],
  },
  {
    id: 'apple',
    name: 'Apple Calendar',
    fields: [
      { key: 'APPLE_CALDAV_USERNAME', label: 'Apple ID', placeholder: 'your@apple.id' },
      { key: 'APPLE_CALDAV_PASSWORD', label: 'App-Specific Password', type: 'password', placeholder: 'xxxx-xxxx-xxxx-xxxx' },
      { key: 'APPLE_CALDAV_CALENDARS', label: 'Calendar Names (comma-separated)', type: 'textarea', placeholder: 'Work,Personal' },
    ],
  },
  {
    id: 'settings',
    name: 'Settings',
    fields: [
      { key: 'BACKFILL_DAYS', label: 'Backfill Days', placeholder: '7' },
      { key: 'TOPIC_ALLOWLIST', label: 'Topic Allowlist', type: 'textarea', placeholder: 'deploy,release,incident' },
    ],
  },
]

export default function SourcesPage() {
  const [vars, setVars] = useState<EnvVars>({})
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null)

  const showToast = (type: 'success' | 'error', msg: string) => {
    setToast({ type, msg })
    setTimeout(() => setToast(null), 3000)
  }

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/config')
      const data = await res.json()
      if (data.vars) setVars(data.vars)
    } catch {
      showToast('error', 'Failed to load config')
    }
  }, [])

  useEffect(() => {
    fetchConfig()
  }, [fetchConfig])

  const handleSave = async (fields: SourceField[], localVars: EnvVars) => {
    const body = fields.map((f) => ({ key: f.key, value: localVars[f.key] ?? '' }))
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.ok) {
        showToast('success', 'Configuration saved')
        fetchConfig()
      } else {
        showToast('error', data.error || 'Save failed')
      }
    } catch (err) {
      showToast('error', String(err))
    }
  }

  const handleCalendarFetch = async (setVar: (key: string, val: string) => void) => {
    try {
      const res = await fetch('/api/calendars')
      const data = await res.json()
      if (data.calendars) {
        const names = (data.calendars as { name: string }[]).map((c) => c.name).join(',')
        setVar('APPLE_CALDAV_CALENDARS', names)
        showToast('success', `Found ${data.calendars.length} calendars`)
      } else {
        showToast('error', data.error || 'Failed to fetch calendars')
      }
    } catch (err) {
      showToast('error', String(err))
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-zinc-100">Sources</h1>
        <p className="text-zinc-400 mt-1">Configure your data source connections</p>
      </div>

      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg text-sm font-medium shadow-lg ${
            toast.type === 'success'
              ? 'bg-green-500/20 border border-green-500/30 text-green-300'
              : 'bg-red-500/20 border border-red-500/30 text-red-300'
          }`}
        >
          {toast.msg}
        </div>
      )}

      <div className="space-y-3">
        {SOURCES.map((source) => (
          <SourceCard
            key={source.id}
            source={source}
            vars={vars}
            onSave={handleSave}
            onCalendarFetch={source.id === 'apple' ? handleCalendarFetch : undefined}
          />
        ))}
      </div>
    </div>
  )
}
