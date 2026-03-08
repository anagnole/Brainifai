import type Graph from 'graphology';
import type { Subgraph } from './api';
import { NODE_COLORS } from './colors';

export function mergeSubgraph(graph: Graph, subgraph: Subgraph): void {
  for (const node of subgraph.nodes) {
    if (!graph.hasNode(node.id)) {
      const label = node.name.length > 20 ? node.name.slice(0, 20) + '...' : node.name;
      graph.addNode(node.id, {
        label,
        entityType: node.type,
        color: NODE_COLORS[node.type] ?? '#999',
        size: 8,
        x: Math.random() * 100,
        y: Math.random() * 100,
      });
    }
  }

  for (const edge of subgraph.edges) {
    const edgeKey = `${edge.source}-${edge.type}-${edge.target}`;
    if (!graph.hasEdge(edgeKey)) {
      try {
        graph.addEdgeWithKey(edgeKey, edge.source, edge.target, {
          label: edge.type,
        });
      } catch {
        // Skip if source/target node missing
      }
    }
  }
}

/** Update node sizes based on degree (connectivity). */
export function updateNodeSizes(graph: Graph): void {
  graph.forEachNode((node) => {
    const degree = graph.degree(node);
    graph.setNodeAttribute(node, 'size', 5 + Math.min(degree * 2, 30));
  });
}
