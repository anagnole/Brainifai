/** Cached children list, queried once at MCP server startup before GraphStore opens. */

import type { RecentActivity } from '../instance/types.js';

/** Minimal child-instance info used by memory-routing code. */
export interface ChildInstanceContext {
  name: string;
  type: string;
  description: string;
  path: string;
  recentActivities?: RecentActivity[];
}

let cache: ChildInstanceContext[] | null = null;

export function setChildrenCache(children: ChildInstanceContext[]): void {
  cache = children;
}

export function getChildrenCache(): ChildInstanceContext[] | null {
  return cache;
}
