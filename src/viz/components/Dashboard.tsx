import { useState, useEffect, useCallback, useRef } from 'react';
import {
  fetchInstances,
  updateDescription,
  fetchEngineOverview,
  type Instance,
  type EngineOverview,
} from '../lib/api';

const TYPE_COLORS: Record<string, string> = {
  coding: '#4a90d9',
  manager: '#f5a623',
  ehr: '#50c878',
  general: '#71717a',
};

function TypeBadge({ type }: { type: string }) {
  const color = TYPE_COLORS[type] ?? TYPE_COLORS.general;
  return (
    <span
      className="instance-type-badge"
      style={{ color, borderColor: color }}
    >
      {type}
    </span>
  );
}

function InstanceCard({
  instance,
  onRefresh,
}: {
  instance: Instance;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [desc, setDesc] = useState(instance.description);
  const [saving, setSaving] = useState(false);
  const borderColor = TYPE_COLORS[instance.type] ?? TYPE_COLORS.general;

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateDescription(instance.name, desc);
      onRefresh();
    } finally {
      setSaving(false);
    }
  }, [instance.name, desc, onRefresh]);

  return (
    <div
      className={`instance-card ${expanded ? 'expanded' : ''}`}
      style={{ borderLeftColor: borderColor }}
    >
      <div
        className="instance-card-header"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="instance-card-title">
          <span className="instance-name">{instance.name}</span>
          <TypeBadge type={instance.type} />
        </div>
        <div className="instance-card-meta">
          <span className="instance-activity-count">
            {instance.recentActivities.length} recent
          </span>
          <span className="instance-expand-arrow">
            {expanded ? '\u25B2' : '\u25BC'}
          </span>
        </div>
      </div>

      {!expanded && instance.description && (
        <div className="instance-card-snippet">
          {instance.description.slice(0, 100)}
          {instance.description.length > 100 ? '...' : ''}
        </div>
      )}

      {expanded && (
        <div className="instance-card-details">
          <div className="detail-section">
            <label className="detail-label">Description</label>
            <textarea
              className="detail-textarea"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={3}
            />
            <button
              className="detail-save-btn"
              onClick={handleSave}
              disabled={saving || desc === instance.description}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>

          {instance.sources.length > 0 && (
            <div className="detail-section">
              <label className="detail-label">Sources</label>
              <div className="detail-tags">
                {instance.sources.map((s) => (
                  <span key={s.source} className="detail-tag">{s.source}</span>
                ))}
              </div>
            </div>
          )}

          {instance.contextFunctions.length > 0 && (
            <div className="detail-section">
              <label className="detail-label">Context Functions</label>
              <div className="detail-tags">
                {instance.contextFunctions.map((f) => (
                  <span key={f} className="detail-tag">{f}</span>
                ))}
              </div>
            </div>
          )}

          {instance.dbSizeBytes != null && (
            <div className="detail-section">
              <label className="detail-label">DB Size</label>
              <span className="detail-value">{(instance.dbSizeBytes / 1024 / 1024).toFixed(1)} MB</span>
            </div>
          )}

          {instance.recentActivities.length > 0 && (
            <div className="detail-section">
              <label className="detail-label">Recent Activities</label>
              <div className="activity-list">
                {instance.recentActivities.map((a, i) => (
                  <div key={i} className="activity-item">
                    <span className="activity-time">
                      {new Date(a.timestamp).toLocaleString()}
                    </span>
                    <span className="activity-kind">{a.kind}</span>
                    <span className="activity-snippet">{a.snippet}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Dashboard() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [engine, setEngine] = useState<EngineOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const [insts, ov] = await Promise.all([
        fetchInstances(),
        fetchEngineOverview(),
      ]);
      if (mountedRef.current) {
        setInstances(insts);
        setEngine(ov);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : 'Failed to load instances');
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const globalInstance = instances.find((i) => i.name === 'global');
  const children = instances.filter((i) => i.name !== 'global');
  const totalDbSize = instances.reduce((sum, i) => sum + (i.dbSizeBytes ?? 0), 0);

  return (
    <div className="dashboard">
      <h1 className="dashboard-title">Dashboard</h1>

      {/* Summary stats — instance metadata + engine graph counts */}
      <div className="stats-row">
        <div className="stat-card">
          <span className="stat-number">{instances.length}</span>
          <span className="stat-label-text">Instances</span>
        </div>
        <div className="stat-card">
          <span className="stat-number">{(totalDbSize / 1024 / 1024).toFixed(0)} MB</span>
          <span className="stat-label-text">Total DB Size</span>
        </div>
        {engine && (
          <>
            <div className="stat-card">
              <span className="stat-number">{engine.counts.atoms}</span>
              <span className="stat-label-text">Atoms</span>
            </div>
            <div className="stat-card">
              <span className="stat-number">{engine.counts.entities}</span>
              <span className="stat-label-text">Entities</span>
            </div>
            <div className="stat-card">
              <span className="stat-number">{engine.counts.episodes}</span>
              <span className="stat-label-text">Episodes</span>
            </div>
            <div className="stat-card">
              <span className="stat-number">{engine.counts.mentions}</span>
              <span className="stat-label-text">Mentions</span>
            </div>
          </>
        )}
      </div>

      {/* Recent atoms — quick glance at what's been written lately */}
      {engine && engine.recentAtoms.length > 0 && (
        <div className="dashboard-section">
          <h2 className="dashboard-section-title">Recent atoms</h2>
          <div className="recent-atoms-list">
            {engine.recentAtoms.slice(0, 5).map((a) => (
              <div key={a.id} className="recent-atom-row">
                <span className="recent-atom-meta">
                  <span className="recent-atom-kind">{a.kind}</span>
                  <span className="recent-atom-date">
                    {new Date(a.created_at).toLocaleDateString()}
                  </span>
                </span>
                <span className="recent-atom-content">
                  {a.content.length > 200 ? a.content.slice(0, 200) + '…' : a.content}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top entities — currently-prominent things in the graph */}
      {engine && engine.topEntities.length > 0 && (
        <div className="dashboard-section">
          <h2 className="dashboard-section-title">Top entities</h2>
          <div className="top-entities-list">
            {engine.topEntities.slice(0, 12).map((e) => (
              <div key={e.id} className="top-entity-pill">
                <span className="top-entity-name">{e.name}</span>
                <span className="top-entity-meta">
                  {e.type} · {e.mentionCount}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && <div className="dashboard-loading">Loading instances...</div>}
      {error && <div className="dashboard-error">{error}</div>}

      {!loading && !error && (
        <div className="instance-tree">
          {/* Global root */}
          {globalInstance && (
            <div className="tree-root">
              <InstanceCard instance={globalInstance} onRefresh={load} />
              {children.length > 0 && (
                <div className="tree-children">
                  <div className="tree-connector" />
                  <div className="tree-child-list">
                    {children.map((child) => (
                      <div key={child.name} className="tree-child">
                        <div className="tree-branch" />
                        <InstanceCard instance={child} onRefresh={load} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* If no global instance, just list all */}
          {!globalInstance && children.length > 0 && (
            <div className="tree-child-list">
              {instances.map((inst) => (
                <div key={inst.name} className="tree-child">
                  <InstanceCard instance={inst} onRefresh={load} />
                </div>
              ))}
            </div>
          )}

          {instances.length === 0 && (
            <div className="dashboard-empty">
              No instances found. Run ingestion to get started.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
