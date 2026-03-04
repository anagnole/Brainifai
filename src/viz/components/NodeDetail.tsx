import { useState, useCallback } from 'react';
import type { EntitySummary, TimelineItem } from '../lib/api';
import { fetchTimeline } from '../lib/api';

interface Props {
  summary: EntitySummary;
  onConnectionClick: (name: string) => void;
}

export function NodeDetail({ summary, onConnectionClick }: Props) {
  const [timeline, setTimeline] = useState<TimelineItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadTimeline = useCallback(async () => {
    setLoading(true);
    const items = await fetchTimeline(summary.id);
    setTimeline(items);
    setLoading(false);
  }, [summary.id]);

  return (
    <div className="node-detail">
      <h2>{summary.name}</h2>
      <div className="type">
        <span className={`type-badge ${summary.type}`}>{summary.type}</span>
      </div>

      <div className="stat">
        <span className="stat-label">Activities</span>
        <span>{summary.activityCount}</span>
      </div>

      {summary.recentActivity && (
        <div className="stat">
          <span className="stat-label">Last active</span>
          <span>{new Date(summary.recentActivity).toLocaleDateString()}</span>
        </div>
      )}

      {summary.topConnections.length > 0 && (
        <div className="connections-list">
          <h3>Top Connections</h3>
          {summary.topConnections.map((c) => (
            <div
              key={c.name}
              className="connection-item"
              onClick={() => onConnectionClick(c.name)}
            >
              <span className={`type-badge ${c.type}`}>{c.type}</span>{' '}
              {c.name} ({c.weight})
            </div>
          ))}
        </div>
      )}

      {!timeline && (
        <button
          onClick={loadTimeline}
          disabled={loading}
          style={{ marginTop: 12, width: '100%', padding: '8px', cursor: 'pointer' }}
        >
          {loading ? 'Loading...' : 'Show Timeline'}
        </button>
      )}

      {timeline && (
        <div className="connections-list" style={{ marginTop: 12 }}>
          <h3>Recent Activity</h3>
          {timeline.map((item, i) => (
            <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
              <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                {new Date(item.timestamp).toLocaleString()} — {item.actor}
              </div>
              <div>{item.snippet}</div>
            </div>
          ))}
          {timeline.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No activity found</div>
          )}
        </div>
      )}
    </div>
  );
}
