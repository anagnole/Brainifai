// ─── Instance types ──────────────────────────────────────────────────────────

export type InstanceType = 'coding' | 'manager' | 'general' | 'ehr' | string;

export interface SourceSubscription {
  source: string;               // "slack", "github", "clickup", "apple-calendar", "claude-code"
  enabled: boolean;
  config?: Record<string, unknown>; // source-specific (e.g., channel IDs, repo names)
}

export interface RecentActivity {
  timestamp: string;            // ISO 8601
  kind: string;                 // activity kind
  snippet: string;              // truncated summary
  topics: string[];             // topic names
}

export interface InstanceConfig {
  name: string;                 // e.g., "aballos", "alfred", "global"
  type: InstanceType;           // template type
  description: string;          // human/AI-readable summary
  parent: string | null;        // parent instance name (null for global)
  sources: SourceSubscription[];
  contextFunctions?: string[];  // which MCP tools/context functions are active
  recentActivities?: RecentActivity[];  // last 5 activities (FIFO)
  createdAt: string;            // ISO 8601
  updatedAt: string;            // ISO 8601
  lastIngestion?: string;       // ISO 8601
}

export interface InstanceInfo {
  config: InstanceConfig;
  path: string;                 // absolute path to .brainifai/ directory
  dbPath: string;               // absolute path to kuzu DB within .brainifai/
  healthy: boolean;             // DB accessible?
}

// ─── Global registry entry (stored in global instance's Kuzu graph) ─────────

export interface InstanceRegistryEntry {
  name: string;
  type: InstanceType;
  description: string;
  path: string;                 // absolute filesystem path to .brainifai/
  parent: string | null;
  status: 'active' | 'stale' | 'removed';
  createdAt: string;
  updatedAt: string;
}
