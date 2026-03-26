import { useState, useEffect, useRef, useCallback } from 'react';
import {
  startIngestion,
  fetchIngestStatus,
  fetchOrchestratorStatus,
  type IngestStatus,
  type OrchestratorStatus,
} from '../lib/api';

function formatLogLine(raw: string): { timestamp: string; level: string; message: string } {
  try {
    const parsed = JSON.parse(raw);
    return {
      timestamp: parsed.timestamp ?? parsed.ts ?? '',
      level: parsed.level ?? parsed.lvl ?? 'info',
      message: parsed.message ?? parsed.msg ?? raw,
    };
  } catch {
    return { timestamp: '', level: 'info', message: raw };
  }
}

function levelClass(level: string): string {
  switch (level.toLowerCase()) {
    case 'error':
    case 'fatal':
      return 'log-error';
    case 'warn':
    case 'warning':
      return 'log-warn';
    case 'debug':
    case 'trace':
      return 'log-debug';
    default:
      return 'log-info';
  }
}

export function IngestPage() {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [ingestStatus, setIngestStatus] = useState<IngestStatus | null>(null);
  const [orchStatus, setOrchStatus] = useState<OrchestratorStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const terminalRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<(() => void) | null>(null);

  // Auto-scroll terminal to bottom
  useEffect(() => {
    const el = terminalRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  // Load status on mount
  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const [ist, ost] = await Promise.all([
        fetchIngestStatus(),
        fetchOrchestratorStatus(),
      ]);
      setIngestStatus(ist);
      setOrchStatus(ost);
    } catch {
      // Status endpoints may not exist yet
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleRun = useCallback(() => {
    setRunning(true);
    setLines([]);

    const abort = startIngestion(
      (msg) => {
        setLines((prev) => [...prev, msg]);
      },
      () => {
        setRunning(false);
        loadStatus();
      },
    );

    abortRef.current = abort;
  }, [loadStatus]);

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
  }, []);

  return (
    <div className="ingest-page">
      <h1 className="page-title">Ingestion</h1>

      <div className="ingest-controls">
        <button
          className="ingest-run-btn"
          onClick={handleRun}
          disabled={running}
        >
          {running ? 'Running...' : 'Run Ingestion'}
        </button>
        {running && (
          <button className="ingest-stop-btn" onClick={handleStop}>
            Stop
          </button>
        )}
      </div>

      {/* Terminal output */}
      <div className="terminal" ref={terminalRef}>
        {lines.length === 0 && !running && (
          <div className="terminal-empty">
            Press "Run Ingestion" to start. Output will appear here.
          </div>
        )}
        {lines.map((raw, i) => {
          const { timestamp, level, message } = formatLogLine(raw);
          return (
            <div key={i} className={`terminal-line ${levelClass(level)}`}>
              {timestamp && (
                <span className="terminal-ts">{timestamp}</span>
              )}
              <span className="terminal-level">[{level}]</span>
              <span className="terminal-msg">{message}</span>
            </div>
          );
        })}
        {running && <div className="terminal-cursor">_</div>}
      </div>

      {/* Status sections */}
      <div className="ingest-status-grid">
        {/* Last Ingestion */}
        <div className="status-panel">
          <h2 className="status-panel-title">Last Ingestion</h2>
          {statusLoading && <div className="status-loading">Loading...</div>}
          {!statusLoading && ingestStatus && (
            <div className="status-content">
              <div className="status-row">
                <span className="status-key">Last Run</span>
                <span className="status-val">
                  {ingestStatus.lastRun
                    ? new Date(ingestStatus.lastRun).toLocaleString()
                    : 'Never'}
                </span>
              </div>
              <div className="status-row">
                <span className="status-key">Status</span>
                <span className={`status-val ${ingestStatus.running ? 'status-active' : ''}`}>
                  {ingestStatus.running ? 'Running' : 'Idle'}
                </span>
              </div>
              {ingestStatus.counts && Object.keys(ingestStatus.counts).length > 0 && (
                <>
                  <div className="status-sub-title">Counts</div>
                  {Object.entries(ingestStatus.counts).map(([k, v]) => (
                    <div key={k} className="status-row">
                      <span className="status-key">{k}</span>
                      <span className="status-val">{v}</span>
                    </div>
                  ))}
                </>
              )}
              {Array.isArray(ingestStatus.cursors) && ingestStatus.cursors.length > 0 && (
                <>
                  <div className="status-sub-title">Cursors</div>
                  {ingestStatus.cursors.map((c: any, i: number) => (
                    <div key={i} className="status-row">
                      <span className="status-key">{c.source}:{c.container_id}</span>
                      <span className="status-val mono">{c.ts?.slice(0, 19) ?? '—'}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
          {!statusLoading && !ingestStatus && (
            <div className="status-empty">No ingestion data available</div>
          )}
        </div>

        {/* Orchestrator Status */}
        <div className="status-panel">
          <h2 className="status-panel-title">Orchestrator</h2>
          {statusLoading && <div className="status-loading">Loading...</div>}
          {!statusLoading && orchStatus && (
            <div className="status-content">
              <div className="status-row">
                <span className="status-key">Lock Status</span>
                <span
                  className={`status-val ${orchStatus.locked ? 'status-locked' : 'status-unlocked'}`}
                >
                  {orchStatus.locked ? 'Locked' : 'Unlocked'}
                </span>
              </div>
              {orchStatus.locked && orchStatus.lockedBy && (
                <div className="status-row">
                  <span className="status-key">Locked By</span>
                  <span className="status-val">{orchStatus.lockedBy}</span>
                </div>
              )}
              {orchStatus.locked && orchStatus.since && (
                <div className="status-row">
                  <span className="status-key">Since</span>
                  <span className="status-val">
                    {new Date(orchStatus.since).toLocaleString()}
                  </span>
                </div>
              )}
              {orchStatus.pid && (
                <div className="status-row">
                  <span className="status-key">PID</span>
                  <span className="status-val mono">{orchStatus.pid}</span>
                </div>
              )}
            </div>
          )}
          {!statusLoading && !orchStatus && (
            <div className="status-empty">No orchestrator data available</div>
          )}
        </div>
      </div>
    </div>
  );
}
