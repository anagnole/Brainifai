const BASE = '/api';

export interface SearchResult {
  id: string;
  type: string;
  name: string;
  score: number;
}

export interface SubgraphNode {
  id: string;
  type: string;
  name: string;
}

export interface SubgraphEdge {
  source: string;
  target: string;
  type: string;
}

export interface Subgraph {
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
}

export interface EntitySummary {
  id: string;
  type: string;
  name: string;
  activityCount: number;
  recentActivity?: string;
  topConnections: Array<{ name: string; type: string; weight: number }>;
}

export interface TimelineItem {
  timestamp: string;
  source: string;
  kind: string;
  snippet: string;
  url?: string;
  actor: string;
  channel: string;
}

export interface Instance {
  name: string;
  type: string;
  description: string;
  path: string;
  status: string;
  sources: Array<{ source: string; enabled: boolean }>;
  contextFunctions: string[];
  recentActivities: Array<{
    timestamp: string;
    kind: string;
    snippet: string;
    topics?: string[];
  }>;
  dbSizeBytes: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestratorStatus {
  locked: boolean;
  lockedBy?: string;
  since?: string;
  pid?: number;
}

export interface IngestStatus {
  lastRun?: string;
  lastStatus?: string;
  counts?: Record<string, number>;
  cursors?: Array<{ source: string; container_id: string; ts: string }>;
  running?: boolean;
}

export async function searchEntities(
  q: string,
  types?: string[],
  limit = 10,
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (types?.length) params.set('types', types.join(','));
  const res = await fetch(`${BASE}/search?${params}`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchNeighborhood(
  id: string,
  maxNodes = 30,
  maxEdges = 60,
): Promise<Subgraph> {
  const params = new URLSearchParams({
    id,
    maxNodes: String(maxNodes),
    maxEdges: String(maxEdges),
  });
  const res = await fetch(`${BASE}/neighborhood?${params}`);
  if (!res.ok) return { nodes: [], edges: [] };
  return res.json();
}

export async function fetchTimeline(
  id: string,
  from?: string,
  to?: string,
  limit = 20,
): Promise<TimelineItem[]> {
  const params = new URLSearchParams({ id, limit: String(limit) });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const res = await fetch(`${BASE}/timeline?${params}`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchEntitySummary(
  id: string,
): Promise<EntitySummary | null> {
  const res = await fetch(`${BASE}/entity/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchOverview(): Promise<Subgraph> {
  const res = await fetch(`${BASE}/overview`);
  if (!res.ok) return { nodes: [], edges: [] };
  return res.json();
}

/* ── Graph instance switching ── */

export async function getCurrentGraphInstance(): Promise<string> {
  const res = await fetch(`${BASE}/graph/current`);
  if (!res.ok) return 'unknown';
  const data = await res.json();
  return data.instance;
}

export async function switchGraphInstance(name: string): Promise<void> {
  const res = await fetch(`${BASE}/graph/switch/${encodeURIComponent(name)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Switch failed' }));
    throw new Error(err.error ?? 'Failed to switch instance');
  }
}

/* ── New API functions for Dashboard / Ingest pages ── */

export async function fetchInstances(): Promise<Instance[]> {
  const res = await fetch(`${BASE}/instances`);
  if (!res.ok) return [];
  return res.json();
}

export async function updateDescription(
  name: string,
  description: string,
): Promise<void> {
  await fetch(`${BASE}/instances/${encodeURIComponent(name)}/description`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
}

export async function fetchOrchestratorStatus(): Promise<OrchestratorStatus> {
  const res = await fetch(`${BASE}/orchestrator/status`);
  if (!res.ok) return { locked: false };
  return res.json();
}

export async function fetchIngestStatus(): Promise<IngestStatus> {
  const res = await fetch(`${BASE}/ingest/status`);
  if (!res.ok) return { running: false };
  return res.json();
}

/* ── Sources management ── */

export interface SourcesData {
  slack: { configured: boolean; tokenSet: boolean; tokenMasked: string | null; items: string[] };
  github: { configured: boolean; tokenSet: boolean; tokenMasked: string | null; items: string[] };
  clickup: { configured: boolean; tokenSet: boolean; tokenMasked: string | null; items: string[] };
  'apple-calendar': { configured: boolean; usernameSet: boolean; usernameMasked: string | null; passwordSet: boolean; calendars: string[] };
  'claude-code': { configured: boolean; projectsPath: string };
  global: { backfillDays: number; topicAllowlist: string[] };
  [key: string]: unknown;
}

export async function fetchSources(): Promise<SourcesData> {
  const res = await fetch(`${BASE}/sources`);
  if (!res.ok) throw new Error('Failed to fetch sources');
  return res.json();
}

export async function updateSourceItems(source: string, items: string[]): Promise<void> {
  const body = source === 'apple-calendar' ? { calendars: items } : { items };
  await fetch(`${BASE}/sources/${encodeURIComponent(source)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function updateSourceToken(
  source: string,
  creds: { token?: string; username?: string; password?: string },
): Promise<void> {
  await fetch(`${BASE}/sources/${encodeURIComponent(source)}/token`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(creds),
  });
}

export async function updateGlobalSettings(
  settings: { backfillDays?: number; topicAllowlist?: string[] },
): Promise<void> {
  await fetch(`${BASE}/sources/global`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
}

/* ── Graph-engine endpoints (new Atom/Entity/Episode schema) ── */

export interface EngineOverview {
  dbPath: string;
  counts: {
    atoms: number;
    entities: number;
    episodes: number;
    mentions: number;
    associations: number;
  };
  topEntities: Array<{ id: string; name: string; type: string; mentionCount: number }>;
  recentAtoms: Array<{ id: string; content: string; kind: string; created_at: string; cwd: string }>;
}

export interface EngineSeedHit {
  id: string;
  name: string;
  type: string;
  mentionCount: number;
  confidence: number;
}

export interface EngineAtomDetail {
  atom: Record<string, unknown>;
  mentions: Array<{ id: string; name: string; type: string; prominence: number }>;
  episode: { id: string; start_time: string; cwd: string } | null;
}

export interface EngineEntityDetail {
  entity: Record<string, unknown>;
  mentioningAtoms: Array<{ id: string; content: string; kind: string; created_at: string; prominence: number }>;
  associations: Array<{ id: string; name: string; type: string; weight: number }>;
}

export interface EngineNeighborhood {
  nodes: Array<{ id: string; name: string; type: string; activation: number }>;
  edges: Array<{ source: string; target: string; weight: number }>;
}

export interface EngineEpisode {
  id: string;
  start_time: string;
  end_time: string;
  cwd: string;
  source_instance: string;
  closed: boolean;
  atomCount: number;
}

export async function fetchEngineOverview(): Promise<EngineOverview | null> {
  const res = await fetch(`${BASE}/engine/overview`);
  if (!res.ok) return null;
  return res.json();
}

export async function searchEngine(q: string): Promise<EngineSeedHit[]> {
  const res = await fetch(`${BASE}/engine/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchEngineAtom(id: string): Promise<EngineAtomDetail | null> {
  const res = await fetch(`${BASE}/engine/atom/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchEngineEntity(id: string): Promise<EngineEntityDetail | null> {
  const res = await fetch(`${BASE}/engine/entity/${encodeURIComponent(id)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchEngineNeighborhood(
  id: string, hops: 1 | 2 = 1,
): Promise<EngineNeighborhood | null> {
  const res = await fetch(`${BASE}/engine/neighborhood/${encodeURIComponent(id)}?hops=${hops}`);
  if (!res.ok) return null;
  return res.json();
}

export async function fetchEngineEpisodes(): Promise<EngineEpisode[]> {
  const res = await fetch(`${BASE}/engine/episodes`);
  if (!res.ok) return [];
  return res.json();
}

export function startIngestion(
  onMessage: (msg: string) => void,
  onDone: () => void,
): () => void {
  const controller = new AbortController();

  fetch(`${BASE}/ingest/run`, {
    method: 'POST',
    signal: controller.signal,
  })
    .then(async (res) => {
      if (!res.ok || !res.body) {
        onMessage(`[error] Ingestion request failed: ${res.status}`);
        onDone();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('data: ')) {
            onMessage(trimmed.slice(6));
          } else {
            onMessage(trimmed);
          }
        }
      }

      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data: ')) {
          onMessage(trimmed.slice(6));
        } else {
          onMessage(trimmed);
        }
      }

      onDone();
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        onMessage(`[error] ${err.message}`);
      }
      onDone();
    });

  return () => controller.abort();
}
