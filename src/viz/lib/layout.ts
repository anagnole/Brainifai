import forceAtlas2 from 'graphology-layout-forceatlas2';
import noverlap from 'graphology-layout-noverlap';
import type Graph from 'graphology';

export function runLayout(graph: Graph, iterations = 100): void {
  if (graph.order < 2) return;

  forceAtlas2.assign(graph, {
    iterations,
    settings: {
      gravity: 1,
      scalingRatio: 2,
      barnesHutOptimize: graph.order > 100,
    },
  });

  noverlap.assign(graph, { maxIterations: 50 });
}
