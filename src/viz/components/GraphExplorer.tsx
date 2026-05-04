// Engine-aware graph explorer.
// Loads top entities from /api/engine/overview as the starter graph, expands
// neighborhoods on click via /api/engine/neighborhood, fetches entity detail
// (mention count, top associations, mentioning atoms) via /api/engine/entity.
// Falls back gracefully when the engine DB is empty.

import { useState, useCallback, useEffect, useMemo } from 'react';
import Graph from 'graphology';
import type {
  EntitySummary,
  TimelineItem,
  Subgraph,
  SearchResult,
  Instance,
} from '../lib/api';
import {
  fetchInstances,
  fetchEngineOverview,
  fetchEngineEntity,
  fetchEngineNeighborhood,
  searchEngine,
  type EngineNeighborhood,
} from '../lib/api';
import { mergeSubgraph, updateNodeSizes } from '../lib/graph-builder';
import { runLayout } from '../lib/layout';
import { SigmaRenderer } from './SigmaRenderer';
import { SearchBar } from './SearchBar';
import { NodeDetail } from './NodeDetail';

// ─── Adapters from engine shapes to legacy SubgraphNode/Edge ────────────────

function neighborhoodToSubgraph(eng: EngineNeighborhood): Subgraph {
  return {
    nodes: eng.nodes.map((n) => ({ id: n.id, type: n.type, name: n.name })),
    edges: eng.edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: 'ASSOCIATED',
    })),
  };
}

function topEntitiesToSubgraph(
  topEntities: Array<{ id: string; name: string; type: string; mentionCount: number }>,
): Subgraph {
  return {
    nodes: topEntities.map((e) => ({ id: e.id, type: e.type, name: e.name })),
    edges: [],
  };
}

const engineSearchFn = async (q: string): Promise<SearchResult[]> => {
  const hits = await searchEngine(q);
  return hits.map((h) => ({ id: h.id, type: h.type, name: h.name, score: h.confidence }));
};

export function GraphExplorer() {
  const [graph] = useState(() => new Graph());
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [entitySummary, setEntitySummary] = useState<EntitySummary | null>(null);
  const [timelineCache, setTimelineCache] = useState<Map<string, TimelineItem[]>>(new Map());
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);

  // Instance picker (informational — the engine DB resolution is per-process).
  const [instances, setInstances] = useState<Instance[]>([]);
  const [currentInstance, setCurrentInstance] = useState<string>('global');

  useEffect(() => {
    (async () => {
      try {
        const list = await fetchInstances();
        setInstances(list);
      } catch (err) {
        console.error('[GraphExplorer] failed to load instances:', err);
      }
    })();
  }, []);

  // Initial graph load: top entities from engine overview, no edges yet —
  // user clicks a node to expand its neighborhood.
  const loadOverview = useCallback(async () => {
    setLoading(true);
    setReady(false);
    setSelectedNode(null);
    setEntitySummary(null);
    setHighlightedNodes(new Set());
    setEmptyMessage(null);
    graph.clear();

    try {
      const ov = await fetchEngineOverview();
      if (!ov) {
        setEmptyMessage('Engine API not reachable. Make sure MCP is running.');
        return;
      }
      if (ov.topEntities.length === 0) {
        setEmptyMessage(
          ov.counts.atoms === 0
            ? 'Engine graph is empty. Use /remember in Claude or wait for the worker to extract entities from a fresh atom.'
            : 'No entities yet — worker may still be running. Refresh in a few seconds.',
        );
        return;
      }
      mergeSubgraph(graph, topEntitiesToSubgraph(ov.topEntities));
      updateNodeSizes(graph);
      runLayout(graph);
    } catch (err) {
      console.error('[GraphExplorer] failed to load engine overview:', err);
      setEmptyMessage('Failed to load engine graph: ' + (err as Error).message);
    } finally {
      setLoading(false);
      setReady(true);
    }
  }, [graph]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  const expandNode = useCallback(
    async (nodeId: string) => {
      const eng = await fetchEngineNeighborhood(nodeId, 1);
      if (!eng) return;
      mergeSubgraph(graph, neighborhoodToSubgraph(eng));
      updateNodeSizes(graph);
      runLayout(graph);
    },
    [graph],
  );

  const handleNodeClick = useCallback(
    async (nodeId: string) => {
      setSelectedNode(nodeId);
      setHighlightedNodes(new Set([nodeId]));

      const [detail] = await Promise.all([
        fetchEngineEntity(nodeId),
        expandNode(nodeId),
      ]);

      if (!detail) {
        setEntitySummary(null);
        return;
      }

      const e = detail.entity as Record<string, unknown>;
      const summary: EntitySummary = {
        id: String(e.id ?? nodeId),
        name: String(e.name ?? nodeId),
        type: String(e.type ?? 'other'),
        activityCount: Number(e.mention_count ?? detail.mentioningAtoms.length),
        recentActivity: detail.mentioningAtoms[0]?.created_at,
        topConnections: detail.associations.slice(0, 8).map((a) => ({
          name: a.name,
          type: a.type,
          weight: a.weight,
        })),
      };
      setEntitySummary(summary);

      // Cache the entity's mentioning atoms as TimelineItem for NodeDetail.
      const items: TimelineItem[] = detail.mentioningAtoms.map((m) => ({
        timestamp: m.created_at,
        source: 'engine',
        kind: m.kind,
        snippet: m.content,
        actor: '',
        channel: '',
      }));
      setTimelineCache((prev) => {
        const next = new Map(prev);
        next.set(summary.id, items);
        return next;
      });
    },
    [expandNode],
  );

  const handleConnectionClick = useCallback(
    (name: string) => {
      // Connections are returned with name only — find the node by label.
      const match = graph.findNode(
        (_, attr) => attr.label === name || attr.label === name.slice(0, 20) + '...',
      );
      if (match) handleNodeClick(match);
    },
    [graph, handleNodeClick],
  );

  const handleSearchSelect = useCallback(
    (id: string) => handleNodeClick(id),
    [handleNodeClick],
  );

  const timelineFn = useMemo(
    () => async (id: string) => timelineCache.get(id) ?? [],
    [timelineCache],
  );

  return (
    <div className="app">
      <div className="sidebar">
        {instances.length > 0 && (
          <div className="instance-picker">
            <label className="instance-picker-label">Instance</label>
            <select
              className="instance-picker-select"
              value={currentInstance}
              onChange={(e) => setCurrentInstance(e.target.value)}
              disabled
              title="Engine DB is resolved per-process; restart MCP to switch."
            >
              {instances.map((inst) => (
                <option key={inst.name} value={inst.name}>
                  {inst.name} ({inst.type})
                </option>
              ))}
            </select>
          </div>
        )}
        <SearchBar
          onSelect={handleSearchSelect}
          searchFn={engineSearchFn}
          placeholder="Search entities (paraphrase ok)..."
        />
        {entitySummary && (
          <NodeDetail
            summary={entitySummary}
            onConnectionClick={handleConnectionClick}
            timelineFn={timelineFn}
          />
        )}
        <div className="graph-hint" style={{ padding: '12px', fontSize: 12, color: 'var(--text-muted)' }}>
          Top entities are shown by default. Click any node to load its
          neighborhood (1 hop) and view its details + mentioning atoms.
        </div>
      </div>
      {ready ? (
        emptyMessage ? (
          <div className="graph-canvas">
            <div className="loading-overlay" style={{ flexDirection: 'column', gap: 8 }}>
              <div>{emptyMessage}</div>
              <button
                onClick={loadOverview}
                style={{ padding: '6px 12px', cursor: 'pointer' }}
              >
                Reload
              </button>
            </div>
          </div>
        ) : (
          <SigmaRenderer
            graph={graph}
            onNodeClick={handleNodeClick}
            highlightedNodes={highlightedNodes}
          />
        )
      ) : (
        <div className="graph-canvas">
          <div className="loading-overlay">
            {loading ? 'Loading engine graph...' : 'Initializing...'}
          </div>
        </div>
      )}
    </div>
  );
}
