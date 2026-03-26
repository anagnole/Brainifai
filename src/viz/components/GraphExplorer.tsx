import { useState, useCallback, useEffect } from 'react';
import Graph from 'graphology';
import type { EntitySummary, Instance } from '../lib/api';
import {
  fetchNeighborhood,
  fetchEntitySummary,
  fetchOverview,
  fetchInstances,
  getCurrentGraphInstance,
  switchGraphInstance,
} from '../lib/api';
import { mergeSubgraph, updateNodeSizes } from '../lib/graph-builder';
import { runLayout } from '../lib/layout';
import { SigmaRenderer } from './SigmaRenderer';
import { SearchBar } from './SearchBar';
import { NodeDetail } from './NodeDetail';
import { TimeSlider } from './TimeSlider';

export function GraphExplorer() {
  const [graph] = useState(() => new Graph());
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [entitySummary, setEntitySummary] = useState<EntitySummary | null>(null);
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set());
  const [timeRange, setTimeRange] = useState(() => {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    return { from, to };
  });
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);

  // Instance picker state
  const [instances, setInstances] = useState<Instance[]>([]);
  const [currentInstance, setCurrentInstance] = useState<string>('');
  const [switching, setSwitching] = useState(false);

  // Load available instances and current instance on mount
  useEffect(() => {
    (async () => {
      try {
        const [instanceList, active] = await Promise.all([
          fetchInstances(),
          getCurrentGraphInstance(),
        ]);
        setInstances(instanceList);
        setCurrentInstance(active);
      } catch (err) {
        console.error('[GraphExplorer] failed to load instances:', err);
      }
    })();
  }, []);

  // Load overview graph — extracted so we can call it after switching
  const loadOverview = useCallback(async () => {
    setLoading(true);
    setReady(false);
    setSelectedNode(null);
    setEntitySummary(null);
    setHighlightedNodes(new Set());

    // Clear existing graph
    graph.clear();

    try {
      const subgraph = await fetchOverview();
      console.log('[GraphExplorer] overview loaded:', subgraph.nodes.length, 'nodes');
      if (subgraph.nodes.length > 0) {
        mergeSubgraph(graph, subgraph);
        updateNodeSizes(graph);
        runLayout(graph);
      }
    } catch (err) {
      console.error('[GraphExplorer] failed to load overview:', err);
    } finally {
      setLoading(false);
      setReady(true);
    }
  }, [graph]);

  // Load initial overview graph on mount
  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  // Handle instance switch
  const handleInstanceSwitch = useCallback(
    async (name: string) => {
      if (name === currentInstance || switching) return;
      setSwitching(true);
      try {
        await switchGraphInstance(name);
        setCurrentInstance(name);
        await loadOverview();
      } catch (err) {
        console.error('[GraphExplorer] failed to switch instance:', err);
      } finally {
        setSwitching(false);
      }
    },
    [currentInstance, switching, loadOverview],
  );

  const expandNode = useCallback(
    async (nodeId: string) => {
      const subgraph = await fetchNeighborhood(nodeId);
      mergeSubgraph(graph, subgraph);
      updateNodeSizes(graph);
      runLayout(graph);
    },
    [graph],
  );

  const handleNodeClick = useCallback(
    async (nodeId: string) => {
      setSelectedNode(nodeId);
      setHighlightedNodes(new Set([nodeId]));

      const [summary] = await Promise.all([
        fetchEntitySummary(nodeId),
        expandNode(nodeId),
      ]);
      setEntitySummary(summary);
    },
    [expandNode],
  );

  const handleConnectionClick = useCallback(
    (name: string) => {
      handleNodeClick(name);
    },
    [handleNodeClick],
  );

  const handleTimeChange = useCallback((from: string, to: string) => {
    setTimeRange({ from, to });
  }, []);

  const handleSearchSelect = useCallback(
    (id: string) => {
      handleNodeClick(id);
    },
    [handleNodeClick],
  );

  return (
    <div className="app">
      <div className="sidebar">
        {instances.length > 0 && (
          <div className="instance-picker">
            <label className="instance-picker-label" htmlFor="instance-select">
              Instance
            </label>
            <select
              id="instance-select"
              className="instance-picker-select"
              value={currentInstance}
              disabled={switching}
              onChange={(e) => handleInstanceSwitch(e.target.value)}
            >
              {instances.map((inst) => (
                <option key={inst.name} value={inst.name}>
                  {inst.name} ({inst.type})
                </option>
              ))}
            </select>
            {switching && (
              <span className="instance-picker-status">Switching...</span>
            )}
          </div>
        )}
        <SearchBar onSelect={handleSearchSelect} />
        {entitySummary && (
          <NodeDetail
            summary={entitySummary}
            onConnectionClick={handleConnectionClick}
          />
        )}
        <TimeSlider
          from={timeRange.from}
          to={timeRange.to}
          onChange={handleTimeChange}
        />
      </div>
      {ready ? (
        <SigmaRenderer
          graph={graph}
          onNodeClick={handleNodeClick}
          highlightedNodes={highlightedNodes}
        />
      ) : (
        <div className="graph-canvas">
          <div className="loading-overlay">Loading graph...</div>
        </div>
      )}
    </div>
  );
}
