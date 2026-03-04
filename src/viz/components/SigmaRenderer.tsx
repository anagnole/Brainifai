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

  useEffect(() => {
    if (!containerRef.current) return;

    const sigma = new Sigma(graph, containerRef.current, {
      renderEdgeLabels: false,
      defaultNodeColor: '#999',
      defaultEdgeColor: '#333',
      labelColor: { color: '#e4e4e7' },
      labelSize: 12,
      nodeReducer: (node, data) => {
        const res = { ...data };
        if (highlightedNodes.size > 0 && !highlightedNodes.has(node)) {
          res.color = '#2a2d3a';
          res.label = '';
        }
        return res;
      },
      edgeReducer: (_edge, data) => {
        return { ...data };
      },
    });

    sigmaRef.current = sigma;

    sigma.on('clickNode', ({ node }) => {
      onNodeClickRef.current(node);
    });

    return () => {
      sigma.kill();
      sigmaRef.current = null;
    };
  }, [graph]); // Only recreate when graph instance changes

  // Update reducers when highlights change
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;

    sigma.setSetting('nodeReducer', (node, data) => {
      const res = { ...data };
      if (highlightedNodes.size > 0 && !highlightedNodes.has(node)) {
        res.color = '#2a2d3a';
        res.label = '';
      }
      return res;
    });

    sigma.refresh();
  }, [highlightedNodes]);

  const handleZoomToFit = useCallback(() => {
    sigmaRef.current?.getCamera().animatedReset({ duration: 500 });
  }, []);

  return (
    <div className="graph-canvas">
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      <div className="toolbar">
        <button onClick={handleZoomToFit}>Fit</button>
      </div>
    </div>
  );
}
