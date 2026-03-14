// ─── Event Bus constants ────────────────────────────────────────────────────

export const EVENT_KINDS = [
  'instance.registered',
  'instance.updated',
  'instance.removed',
  'query.request',
  'query.response',
  'data.push',
] as const;

/** Default directory for event log files */
export const DEFAULT_EVENTS_DIR = '.brainifai/events';

/** How many days of event files to retain before pruning */
export const DEFAULT_RETENTION_DAYS = 7;

/** Poll interval in ms for tailing new events from the log file */
export const DEFAULT_POLL_MS = 500;
