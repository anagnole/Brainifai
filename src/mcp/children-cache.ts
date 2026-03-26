/** Cached children list, queried once at MCP server startup before GraphStore opens. */

import type { InstanceContext } from '../orchestrator/types.js';

let cache: InstanceContext[] | null = null;

export function setChildrenCache(children: InstanceContext[]): void {
  cache = children;
}

export function getChildrenCache(): InstanceContext[] | null {
  return cache;
}
