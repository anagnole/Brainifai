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
