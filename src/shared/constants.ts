export const MAX_SNIPPET_CHARS = 2000;
export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_BACKFILL_DAYS = 7;

// MCP safety limits
export const MAX_EVIDENCE_ITEMS = 20;
export const MAX_TOTAL_CHARS = 16000;
export const MAX_GRAPH_NODES = 20;
export const MAX_GRAPH_EDGES = 40;
export const QUERY_TIMEOUT_MS = 10_000;

// SessionStart hook budgets
export const HOOK_TOTAL_BUDGET = 4000;
export const HOOK_DECISION_SNIPPET_LEN = 200;
export const HOOK_SESSION_SNIPPET_LEN = 150;
export const HOOK_CROSS_PROJECT_SNIPPET_LEN = 150;

// Ingestion
export const UPSERT_BATCH_SIZE = 100;
export const SLACK_PAGE_SIZE = 200;
