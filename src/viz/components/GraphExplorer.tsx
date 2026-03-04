import { useState, useCallback, useEffect } from 'react';
import Graph from 'graphology';
import type { EntitySummary } from '../lib/api';
import { fetchNeighborhood, fetchEntitySummary, fetchOverview } from '../lib/api';
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
  // Counter to force re-render when graph changes
  const [, setGraphVersion] = useState(0);
  const [loading, setLoading] = useState(true);

  // Load initial overview graph on mount
  useEffect(() => {
    (async () => {
      try {
        const subgraph = await fetchOverview();
        if (subgraph.nodes.length > 0) {
          mergeSubgraph(graph, subgraph);
          updateNodeSizes(graph);
          runLayout(graph);
          setGraphVersion((v) => v + 1);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [graph]);

  const expandNode = useCallback(
    async (nodeId: string) => {
      const subgraph = await fetchNeighborhood(nodeId);
      mergeSubgraph(graph, subgraph);
      updateNodeSizes(graph);
      runLayout(graph);
      setGraphVersion((v) => v + 1);
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
      // Connections are identified by name; try to find in graph or expand
      if (graph.hasNode(name)) {
        handleNodeClick(name);
      } else {
        // Expand the connection
        handleNodeClick(name);
      }
    },
    [graph, handleNodeClick],
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
      <SigmaRenderer
        graph={graph}
        onNodeClick={handleNodeClick}
        highlightedNodes={highlightedNodes}
      />
      {loading && (
        <div className="loading-overlay">Loading graph...</div>
      )}
      {!loading && graph.order === 0 && (
        <div className="empty-overlay">
          Search for a person, topic, or channel to explore your knowledge graph
        </div>
      )}
    </div>
  );
}
