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
