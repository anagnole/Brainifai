// ─── Context Function Registry ───────────────────────────────────────────────

import type { ContextFunction, ContextFunctionRegistry } from './types.js';

class Registry implements ContextFunctionRegistry {
  private fns = new Map<string, ContextFunction>();

  register(fn: ContextFunction): void {
    this.fns.set(fn.name, fn);
  }

  get(name: string): ContextFunction | undefined {
    return this.fns.get(name);
  }

  list(): ContextFunction[] {
    return [...this.fns.values()];
  }

  listNames(): string[] {
    return [...this.fns.keys()];
  }

  forInstance(activeNames: string[]): ContextFunction[] {
    const active = new Set(activeNames);
    return this.list().filter((fn) => active.has(fn.name));
  }
}

/**
 * Create a registry pre-loaded with all base context functions.
 * Template-specific functions can be registered on top.
 */
export async function createBaseRegistry(): Promise<ContextFunctionRegistry> {
  const registry = new Registry();

  // Lazy-import to avoid circular deps and keep the registry lightweight
  const [
    { searchEntitiesFn },
    { entitySummaryFn },
    { recentActivityFn },
    { contextPacketFn },
    { ingestMemoryFn },
  ] = await Promise.all([
    import('./functions/search.js'),
    import('./functions/summary.js'),
    import('./functions/activity.js'),
    import('./functions/context-packet.js'),
    import('./functions/ingest-memory.js'),
  ]);

  registry.register(searchEntitiesFn);
  registry.register(entitySummaryFn);
  registry.register(recentActivityFn);
  registry.register(contextPacketFn);
  registry.register(ingestMemoryFn);

  // Template-specific functions — registered in the global pool,
  // but only activated per-instance via contextFunctions config
  const [
    { prSummaryFn },
    { decisionLogFn },
    { peopleContextFn },
    { meetingSummaryFn },
  ] = await Promise.all([
    import('./functions/pr-summary.js'),
    import('./functions/decision-log.js'),
    import('./functions/people-context.js'),
    import('./functions/meeting-summary.js'),
  ]);

  registry.register(prSummaryFn);
  registry.register(decisionLogFn);
  registry.register(peopleContextFn);
  registry.register(meetingSummaryFn);

  // Coding bridge functions — GitNexus code intelligence + Brainifai enrichment
  const {
    searchCodeFn,
    symbolContextFn,
    blastRadiusFn,
    detectChangesFn,
    prContextFn,
  } = await import('./functions/coding-bridge.js');

  registry.register(searchCodeFn);
  registry.register(symbolContextFn);
  registry.register(blastRadiusFn);
  registry.register(detectChangesFn);
  registry.register(prContextFn);

  // Cross-instance function — only activated when instance has a parent
  const { broaderContextFn } = await import('./functions/cross-instance.js');
  registry.register(broaderContextFn);

  return registry;
}
