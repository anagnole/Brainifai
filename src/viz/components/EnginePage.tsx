import { useEffect, useState, useCallback, useMemo } from 'react';
import Graph from 'graphology';
import {
  fetchEngineOverview, searchEngine, fetchEngineEntity,
  fetchEngineAtom, fetchEngineNeighborhood, fetchEngineEpisodes,
  type EngineOverview, type EngineSeedHit, type EngineEntityDetail,
  type EngineAtomDetail, type EngineEpisode,
} from '../lib/api';
import { SigmaRenderer } from './SigmaRenderer';
import { runLayout } from '../lib/layout';

const TYPE_COLORS: Record<string, string> = {
  person: '#f4a261', project: '#7cb518', tool: '#4895ef',
  place: '#d9a05b', concept: '#a855f7', category: '#ec4899',
  topic: '#06b6d4', other: '#94a3b8',
};

function colorFor(type: string): string {
  return TYPE_COLORS[type.toLowerCase()] ?? '#94a3b8';
}

export function EnginePage() {
  const [overview, setOverview] = useState<EngineOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [seeds, setSeeds] = useState<EngineSeedHit[]>([]);
  const [searching, setSearching] = useState(false);

  const [selectedEntity, setSelectedEntity] = useState<EngineEntityDetail | null>(null);
  const [selectedAtom, setSelectedAtom] = useState<EngineAtomDetail | null>(null);

  const [episodes, setEpisodes] = useState<EngineEpisode[]>([]);
  const [graph] = useState(() => new Graph());
  const [graphReady, setGraphReady] = useState(false);

  // Load overview
  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const ov = await fetchEngineOverview();
        if (!ov) throw new Error('Failed to load engine overview. Is the engine DB present?');
        setOverview(ov);
        const eps = await fetchEngineEpisodes();
        setEpisodes(eps);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Cue search (debounced-ish: fire on Enter or explicit button)
  const runSearch = useCallback(async () => {
    if (!query.trim()) { setSeeds([]); return; }
    setSearching(true);
    try {
      const hits = await searchEngine(query.trim());
      setSeeds(hits);
    } finally {
      setSearching(false);
    }
  }, [query]);

  // Load an entity + render its neighborhood subgraph
  const selectEntity = useCallback(async (id: string) => {
    setSelectedAtom(null);
    const detail = await fetchEngineEntity(id);
    setSelectedEntity(detail);

    const neighborhood = await fetchEngineNeighborhood(id, 1);
    if (!neighborhood) return;

    graph.clear();
    for (const n of neighborhood.nodes) {
      const isSeed = n.id === id;
      graph.addNode(n.id, {
        label: n.name,
        entityType: n.type,
        x: Math.random(), y: Math.random(),
        size: isSeed ? 18 : 10 + Math.min(8, n.activation * 12),
        color: isSeed ? '#e8d82b' : colorFor(n.type),
      });
    }
    for (const e of neighborhood.edges) {
      if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.source, e.target)) {
        graph.addEdge(e.source, e.target, {
          size: Math.min(3, 0.5 + e.weight * 0.5),
        });
      }
    }
    runLayout(graph);
    setGraphReady(true);
  }, [graph]);

  const selectAtom = useCallback(async (id: string) => {
    setSelectedEntity(null);
    setSelectedAtom(await fetchEngineAtom(id));
  }, []);

  const countsLine = useMemo(() => {
    if (!overview) return '';
    const c = overview.counts;
    return `atoms: ${c.atoms} · entities: ${c.entities} · episodes: ${c.episodes} · MENTIONS: ${c.mentions} · ASSOCIATED: ${c.associations}`;
  }, [overview]);

  if (loading) return <div className="engine-loading">Loading engine graph…</div>;
  if (error) return (
    <div className="engine-error">
      <h2>Engine unavailable</h2>
      <p>{error}</p>
      <p style={{ opacity: 0.7, fontSize: 12 }}>
        Set BRAINIFAI_ENGINE_DB to an engine-format Kuzu DB, or run:
        <code style={{ display: 'block', marginTop: 8, padding: 8, background: '#1f1f23' }}>
          npx tsx src/scripts/longform-test.ts --persist
        </code>
      </p>
    </div>
  );

  return (
    <div className="engine-page">
      <div className="engine-sidebar">
        <h2>Engine</h2>
        <div className="engine-counts">{countsLine}</div>
        <div className="engine-db">{overview?.dbPath}</div>

        <div className="engine-search">
          <input
            type="text"
            value={query}
            placeholder="search cue (paraphrase OK)"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
          />
          <button onClick={runSearch} disabled={searching}>
            {searching ? '…' : 'search'}
          </button>
        </div>

        {seeds.length > 0 && (
          <div className="engine-section">
            <h3>matches</h3>
            <ul className="engine-list">
              {seeds.map((s) => (
                <li key={s.id}>
                  <button onClick={() => selectEntity(s.id)} className="engine-link">
                    <span className="engine-dot" style={{ background: colorFor(s.type) }}></span>
                    {s.name}
                    <span className="engine-meta">{s.type} · conf {s.confidence.toFixed(2)} · ×{s.mentionCount}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="engine-section">
          <h3>top entities</h3>
          <ul className="engine-list">
            {overview?.topEntities.map((e) => (
              <li key={e.id}>
                <button onClick={() => selectEntity(e.id)} className="engine-link">
                  <span className="engine-dot" style={{ background: colorFor(e.type) }}></span>
                  {e.name}
                  <span className="engine-meta">{e.type} · ×{e.mentionCount}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="engine-section">
          <h3>recent atoms</h3>
          <ul className="engine-list">
            {overview?.recentAtoms.map((a) => (
              <li key={a.id}>
                <button onClick={() => selectAtom(a.id)} className="engine-link">
                  <span className="engine-kind">{a.kind}</span>
                  <span className="engine-content">{a.content.slice(0, 80)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="engine-section">
          <h3>episodes ({episodes.length})</h3>
          <ul className="engine-list">
            {episodes.slice(0, 8).map((ep) => (
              <li key={ep.id}>
                <div className="engine-episode">
                  <div>{new Date(ep.start_time).toLocaleString()}</div>
                  <div className="engine-meta">cwd: {ep.cwd || '(none)'} · atoms: {ep.atomCount} · {ep.closed ? 'closed' : 'open'}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="engine-main">
        {selectedEntity && (
          <div className="engine-detail">
            <h3>{(selectedEntity.entity as any).name}</h3>
            <div className="engine-meta">
              type: {(selectedEntity.entity as any).type} ·
              first seen {(selectedEntity.entity as any).first_seen?.slice(0, 10)} ·
              last seen {(selectedEntity.entity as any).last_seen?.slice(0, 10)} ·
              ×{Number((selectedEntity.entity as any).mention_count ?? 0)}
            </div>

            <div style={{ display: 'flex', gap: 12, marginTop: 12, height: 'calc(100% - 80px)' }}>
              <div style={{ flex: 1, minHeight: 300, background: '#1b1b1f', borderRadius: 6 }}>
                {graphReady && (
                  <SigmaRenderer
                    graph={graph}
                    onNodeClick={(nid) => selectEntity(nid)}
                    highlightedNodes={new Set()}
                  />
                )}
              </div>

              <div className="engine-detail-side">
                <h4>associations</h4>
                <ul className="engine-list">
                  {selectedEntity.associations.map((a) => (
                    <li key={a.id}>
                      <button onClick={() => selectEntity(a.id)} className="engine-link">
                        <span className="engine-dot" style={{ background: colorFor(a.type) }}></span>
                        {a.name}
                        <span className="engine-meta">w={a.weight}</span>
                      </button>
                    </li>
                  ))}
                </ul>

                <h4>atoms mentioning</h4>
                <ul className="engine-list">
                  {selectedEntity.mentioningAtoms.slice(0, 15).map((a) => (
                    <li key={a.id}>
                      <button onClick={() => selectAtom(a.id)} className="engine-link">
                        <span className="engine-kind">{a.kind}</span>
                        <span className="engine-content">{a.content.slice(0, 70)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}

        {selectedAtom && (
          <div className="engine-detail">
            <h3>{(selectedAtom.atom as any).kind ?? 'atom'}</h3>
            <p style={{ lineHeight: 1.5 }}>{(selectedAtom.atom as any).content}</p>
            <div className="engine-meta">
              {String((selectedAtom.atom as any).created_at).slice(0, 10)} ·
              cwd: {(selectedAtom.atom as any).cwd || '(none)'} ·
              tier: {(selectedAtom.atom as any).tier} ·
              salience: {(selectedAtom.atom as any).salience}
            </div>

            <h4 style={{ marginTop: 20 }}>mentions</h4>
            <ul className="engine-list">
              {selectedAtom.mentions.map((m) => (
                <li key={m.id}>
                  <button onClick={() => selectEntity(m.id)} className="engine-link">
                    <span className="engine-dot" style={{ background: colorFor(m.type) }}></span>
                    {m.name}
                    <span className="engine-meta">{m.type} · p={Number(m.prominence).toFixed(2)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!selectedEntity && !selectedAtom && (
          <div className="engine-empty">
            <p>Click a top entity, match, or recent atom to inspect.</p>
            <p style={{ opacity: 0.7 }}>
              Search supports paraphrases — try "the book I was reading" or "the database we chose".
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
