import { useState, useEffect, useCallback } from 'react';
import { fetchSources, updateSourceItems, updateSourceToken, updateGlobalSettings, type SourcesData } from '../lib/api';

/* ── Setup instructions per source ──────────────────────────────────────── */

const INSTRUCTIONS: Record<string, { title: string; steps: string[] }> = {
  slack: {
    title: 'How to set up Slack',
    steps: [
      'Go to api.slack.com/apps and click "Create New App" (from manifest or scratch)',
      'Under OAuth & Permissions, add Bot Token Scopes: channels:history, channels:read, users:read',
      'Click "Install to Workspace" and authorize',
      'Copy the "Bot User OAuth Token" (starts with xoxb-) and paste it above',
      'To find Channel IDs: open Slack, right-click a channel, select "View channel details" — the ID is at the bottom of the panel',
    ],
  },
  github: {
    title: 'How to set up GitHub',
    steps: [
      'Go to github.com/settings/tokens and create a Fine-grained personal access token',
      'Under "Repository access", select the repos you want to ingest',
      'Under "Permissions", grant read access to: Pull requests, Issues, Contents',
      'Copy the token (starts with github_pat_ or ghp_) and paste it above',
      'Add repos in owner/repo format (e.g. "anthropics/claude-code")',
    ],
  },
  clickup: {
    title: 'How to set up ClickUp',
    steps: [
      'Open app.clickup.com, click your avatar (bottom left) → Settings → Apps',
      'Under "API Token", click "Generate" and copy the token (starts with pk_)',
      'To find List IDs: open any list in ClickUp — the URL contains /li/XXXXX — that number is the ID',
      'Add multiple list IDs to ingest tasks from different lists',
    ],
  },
  'apple-calendar': {
    title: 'How to set up Apple Calendar',
    steps: [
      'Uses iCloud CalDAV — your username is your Apple ID email address',
      'For the password, you need an App-Specific Password:',
      'Go to appleid.apple.com → Sign-In and Security → App-Specific Passwords',
      'Click the + to generate a new one, name it "Brainifai"',
      'Calendar names are optional — leave empty to sync all calendars',
    ],
  },
  'claude-code': {
    title: 'About Claude Code ingestion',
    steps: [
      'No setup needed — Brainifai automatically reads Claude Code session transcripts',
      'Sessions are stored at ~/.claude/projects/ and parsed on each ingestion run',
      'If ANTHROPIC_API_KEY is set, sessions are summarized using Claude Haiku for better topic extraction',
      'Without the API key, a metadata-only fallback summary is used',
    ],
  },
};

/* ── Source labels ───────────────────────────────────────────────────────── */

const SOURCE_META: Record<string, { label: string; listLabel: string; listPlaceholder: string }> = {
  slack: { label: 'Slack', listLabel: 'Channel IDs', listPlaceholder: 'C01ABCDEF' },
  github: { label: 'GitHub', listLabel: 'Repositories', listPlaceholder: 'owner/repo' },
  clickup: { label: 'ClickUp', listLabel: 'List IDs', listPlaceholder: 'abc123' },
};

/* ── Components ─────────────────────────────────────────────────────────── */

function InstructionsPanel({ source }: { source: string }) {
  const [open, setOpen] = useState(false);
  const info = INSTRUCTIONS[source];
  if (!info) return null;

  return (
    <div className="source-instructions">
      <button className="source-instructions-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {info.title}
      </button>
      {open && (
        <ol className="source-instructions-list">
          {info.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TokenField({
  source,
  masked,
  isSet,
  label,
  onSave,
}: {
  source: string;
  masked: string | null;
  isSet: boolean;
  label: string;
  onSave: (source: string, token: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!value.trim()) return;
    setSaving(true);
    await onSave(source, value.trim());
    setValue('');
    setEditing(false);
    setSaving(false);
  };

  return (
    <div className="source-token-field">
      <span className="source-field-label">{label}</span>
      {editing ? (
        <div className="source-token-edit">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Paste ${label.toLowerCase()}...`}
            autoFocus
          />
          <button onClick={handleSave} disabled={saving || !value.trim()}>Save</button>
          <button onClick={() => { setEditing(false); setValue(''); }}>Cancel</button>
        </div>
      ) : (
        <div className="source-token-display">
          <code>{isSet ? masked : 'not set'}</code>
          <button onClick={() => setEditing(true)}>{isSet ? 'Change' : 'Set'}</button>
        </div>
      )}
    </div>
  );
}

function ListEditor({
  items,
  placeholder,
  label,
  onUpdate,
}: {
  items: string[];
  placeholder: string;
  label: string;
  onUpdate: (items: string[]) => Promise<void>;
}) {
  const [newItem, setNewItem] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    const val = newItem.trim();
    if (!val || items.includes(val)) return;
    setSaving(true);
    await onUpdate([...items, val]);
    setNewItem('');
    setSaving(false);
  };

  const handleRemove = async (item: string) => {
    setSaving(true);
    await onUpdate(items.filter((i) => i !== item));
    setSaving(false);
  };

  return (
    <div className="source-list-editor">
      <span className="source-field-label">{label}</span>
      <div className="source-list-items">
        {items.map((item) => (
          <div key={item} className="source-list-item">
            <code>{item}</code>
            <button onClick={() => handleRemove(item)} disabled={saving} title="Remove">x</button>
          </div>
        ))}
        {items.length === 0 && <span className="source-list-empty">None configured</span>}
      </div>
      <div className="source-list-add">
        <input
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        />
        <button onClick={handleAdd} disabled={saving || !newItem.trim()}>+ Add</button>
      </div>
    </div>
  );
}

function StandardSourceCard({
  source,
  data,
  onTokenSave,
  onListUpdate,
}: {
  source: string;
  data: { configured: boolean; tokenSet: boolean; tokenMasked: string | null; items: string[] };
  onTokenSave: (source: string, token: string) => Promise<void>;
  onListUpdate: (source: string, items: string[]) => Promise<void>;
}) {
  const meta = SOURCE_META[source];
  return (
    <div className={`source-card ${data.configured ? 'source-connected' : ''}`}>
      <div className="source-card-header">
        <h3>{meta.label}</h3>
        <span className={`source-status ${data.configured ? 'active' : ''}`}>
          {data.configured ? 'Connected' : 'Not configured'}
        </span>
      </div>
      <div className="source-card-body">
        <TokenField source={source} masked={data.tokenMasked} isSet={data.tokenSet} label="Token" onSave={onTokenSave} />
        <ListEditor
          items={data.items}
          placeholder={meta.listPlaceholder}
          label={meta.listLabel}
          onUpdate={(items) => onListUpdate(source, items)}
        />
        <InstructionsPanel source={source} />
      </div>
    </div>
  );
}

function CalendarCard({
  data,
  onTokenSave,
  onListUpdate,
}: {
  data: { configured: boolean; usernameSet: boolean; usernameMasked: string | null; passwordSet: boolean; calendars: string[] };
  onTokenSave: (source: string, token: string) => Promise<void>;
  onListUpdate: (source: string, items: string[]) => Promise<void>;
}) {
  return (
    <div className={`source-card ${data.configured ? 'source-connected' : ''}`}>
      <div className="source-card-header">
        <h3>Apple Calendar</h3>
        <span className={`source-status ${data.configured ? 'active' : ''}`}>
          {data.configured ? 'Connected' : 'Not configured'}
        </span>
      </div>
      <div className="source-card-body">
        <TokenField source="apple-calendar" masked={data.usernameMasked} isSet={data.usernameSet} label="Username"
          onSave={(_, val) => onTokenSave('apple-calendar', val)} />
        <TokenField source="apple-calendar-pass" masked={data.passwordSet ? '****' : null} isSet={data.passwordSet} label="Password"
          onSave={(_, val) => updateSourceToken('apple-calendar', { password: val }).then(() => {})} />
        <ListEditor
          items={data.calendars}
          placeholder="Calendar Name (optional)"
          label="Calendars (empty = all)"
          onUpdate={(items) => onListUpdate('apple-calendar', items)}
        />
        <InstructionsPanel source="apple-calendar" />
      </div>
    </div>
  );
}

function ClaudeCodeCard({ data }: { data: { configured: boolean; projectsPath: string } }) {
  return (
    <div className="source-card source-connected">
      <div className="source-card-header">
        <h3>Claude Code</h3>
        <span className="source-status active">Auto-detected</span>
      </div>
      <div className="source-card-body">
        <div className="source-token-field">
          <span className="source-field-label">Projects path</span>
          <code>{data.projectsPath}</code>
        </div>
        <InstructionsPanel source="claude-code" />
      </div>
    </div>
  );
}

function GlobalSettings({
  data,
  onUpdate,
}: {
  data: { backfillDays: number; topicAllowlist: string[] };
  onUpdate: (settings: { backfillDays?: number; topicAllowlist?: string[] }) => Promise<void>;
}) {
  const [days, setDays] = useState(String(data.backfillDays));
  const [topics, setTopics] = useState(data.topicAllowlist.join(', '));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await onUpdate({
      backfillDays: parseInt(days, 10) || 7,
      topicAllowlist: topics.split(',').map((t) => t.trim()).filter(Boolean),
    });
    setSaving(false);
  };

  const changed =
    days !== String(data.backfillDays) ||
    topics !== data.topicAllowlist.join(', ');

  return (
    <div className="source-card">
      <div className="source-card-header">
        <h3>Global Settings</h3>
      </div>
      <div className="source-card-body">
        <div className="source-token-field">
          <span className="source-field-label">Backfill days (first run)</span>
          <input type="number" value={days} onChange={(e) => setDays(e.target.value)} min="1" max="365" style={{ width: 80 }} />
        </div>
        <div className="source-token-field">
          <span className="source-field-label">Topic allowlist</span>
          <input value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="deploy, testing, incident, ..." />
        </div>
        {changed && (
          <button className="detail-save-btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save settings'}
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Main page ──────────────────────────────────────────────────────────── */

export function SourcesPage() {
  const [data, setData] = useState<SourcesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchSources();
      setData(d);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleTokenSave = async (source: string, token: string) => {
    await updateSourceToken(source, { token });
    await load();
  };

  const handleListUpdate = async (source: string, items: string[]) => {
    await updateSourceItems(source, items);
    await load();
  };

  const handleGlobalUpdate = async (settings: { backfillDays?: number; topicAllowlist?: string[] }) => {
    await updateGlobalSettings(settings);
    await load();
  };

  if (loading) return <div className="dashboard"><p className="dashboard-loading">Loading sources...</p></div>;
  if (error) return <div className="dashboard"><p className="dashboard-error">{error}</p></div>;
  if (!data) return null;

  return (
    <div className="dashboard">
      <h1 className="page-title">Sources</h1>
      <div className="sources-grid">
        <GlobalSettings data={data.global} onUpdate={handleGlobalUpdate} />
        {['slack', 'github', 'clickup'].map((s) => (
          <StandardSourceCard
            key={s}
            source={s}
            data={data[s] as any}
            onTokenSave={handleTokenSave}
            onListUpdate={handleListUpdate}
          />
        ))}
        <CalendarCard
          data={data['apple-calendar'] as any}
          onTokenSave={handleTokenSave}
          onListUpdate={handleListUpdate}
        />
        <ClaudeCodeCard data={data['claude-code'] as any} />
      </div>
    </div>
  );
}
