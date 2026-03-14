// ─── Typed payload interfaces per event kind ────────────────────────────────

export interface InstanceRegisteredData {
  name: string;
  type: string;
  description: string;
  path: string;
  parent: string | null;
}

export interface InstanceUpdatedData {
  name: string;
  fields: Partial<{
    description: string;
    type: string;
    sources: Array<{ source: string; enabled: boolean }>;
    status: string;
  }>;
}

export interface InstanceRemovedData {
  name: string;
  reason?: string;
}

export interface QueryRequestData {
  queryType: 'search' | 'context' | 'activity' | 'custom';
  query: string;
  params?: Record<string, unknown>;
}

export interface QueryResponseData {
  results: unknown;
  error?: string;
}

export interface DataPushData {
  entities: Array<{ kind: string; id: string; props: Record<string, unknown> }>;
  edges?: Array<{ from: string; to: string; rel: string; props?: Record<string, unknown> }>;
}
