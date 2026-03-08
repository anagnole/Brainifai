import { useEffect, useRef, useCallback } from 'react';
import Sigma from 'sigma';
import type Graph from 'graphology';

interface Props {
  graph: Graph;
  onNodeClick: (nodeId: string) => void;
  highlightedNodes: Set<string>;
}

export function SigmaRenderer({ graph, onNodeClick, highlightedNodes }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sigmaRef = useRef<Sigma | null>(null);
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  // Create Sigma instance once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Ensure the container has dimensions before Sigma initializes
    const rect = container.getBoundingClientRect();
    console.log('[Sigma] container dimensions:', rect.width, rect.height);

    const sigma = new Sigma(graph, container, {
      allowInvalidContainer: true,
      renderEdgeLabels: false,
      defaultNodeColor: '#4A90D9',
      defaultEdgeColor: '#555',
      labelColor: { color: '#e4e4e7' },
      labelSize: 11,
      labelRenderedSizeThreshold: 8,
      stagePadding: 30,
    });

    sigmaRef.current = sigma;
    console.log('[Sigma] instance created, graph order:', graph.order);

    // Auto-fit camera to show all nodes
    if (graph.order > 0) {
      sigma.getCamera().animatedReset({ duration: 300 });
    }

    sigma.on('clickNode', ({ node }) => {
      onNodeClickRef.current(node);
    });

    // Observe container resize
    const resizeObserver = new ResizeObserver(() => {
      sigma.refresh();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      sigma.kill();
      sigmaRef.current = null;
    };
  }, [graph]);

  // Update reducers when highlights change
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;

    sigma.setSetting('nodeReducer', (node, data) => {
      if (highlightedNodes.size > 0 && !highlightedNodes.has(node)) {
        return { ...data, color: '#2a2d3a', label: '' };
      }
      return data;
    });

    sigma.refresh();
  }, [highlightedNodes]);

  const handleZoomToFit = useCallback(() => {
    sigmaRef.current?.getCamera().animatedReset({ duration: 500 });
  }, []);

  return (
    <div className="graph-canvas">
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 }}
      />
      <div className="toolbar">
        <button onClick={handleZoomToFit}>Fit</button>
      </div>
    </div>
  );
}
