import type { RecentActivity } from '../instance/types.js';

/** Instance context provided to the orchestrator for routing decisions */
export interface InstanceContext {
  name: string;
  type: string;
  description: string;
  path: string;
  recentActivities?: RecentActivity[];
}
