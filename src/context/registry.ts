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

  // Graph-engine primitives — the new brain-inspired retrieval layer. Active
  // for instances whose `contextFunctions` list them (general by default).
  const engineMod = await import('./functions/engine-primitives.js');
  registry.register(engineMod.workingMemoryFn);
  registry.register(engineMod.associateFn);
  registry.register(engineMod.recallEpisodeFn);
  registry.register(engineMod.consolidateFn);

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

  // EHR-specific functions — registered in the global pool,
  // but only activated for instances with type 'ehr'
  const ehr = await import('./functions/ehr.js');
  registry.register(ehr.searchPatientsFn);
  registry.register(ehr.patientSummaryFn);
  registry.register(ehr.medicationsFn);
  registry.register(ehr.diagnosesFn);
  registry.register(ehr.labsFn);
  registry.register(ehr.temporalRelationFn);
  registry.register(ehr.findCohortFn);
  registry.register(ehr.findObservationConceptsFn);
  registry.register(ehr.aggregateObservationForCohortFn);
  registry.register(ehr.countCohortFn);
  registry.register(ehr.patientAgeFn);
  registry.register(ehr.compareObservationsFn);
  registry.register(ehr.cohortObservationDistributionFn);
  registry.register(ehr.medicationAdherenceFn);
  registry.register(ehr.encounterDetailFn);
  registry.register(ehr.listTreatmentsForConditionFn);
  registry.register(ehr.proceduresFn);
  registry.register(ehr.rankConditionsInCohortFn);

  // Cross-instance function — only activated when instance has a parent
  const { broaderContextFn } = await import('./functions/cross-instance.js');
  registry.register(broaderContextFn);

  // Coding bridge functions — GitNexus × Brainifai (coding instance type)
  const {
    searchCodeFn,
    getSymbolContextFn,
    getBlastRadiusFn,
    detectCodeChangesFn,
    getPrContextFn,
  } = await import('./functions/coding-bridge.js');
  registry.register(searchCodeFn);
  registry.register(getSymbolContextFn);
  registry.register(getBlastRadiusFn);
  registry.register(detectCodeChangesFn);
  registry.register(getPrContextFn);

  // Project Manager functions
  const {
    searchProjectsFn,
    getProjectHealthFn,
    getProjectActivityFn,
    getCrossProjectImpactFn,
    findStaleProjectsFn,
    getDependencyGraphFn,
    getClaudeSessionHistoryFn,
  } = await import('./functions/project-manager.js');

  registry.register(searchProjectsFn);
  registry.register(getProjectHealthFn);
  registry.register(getProjectActivityFn);
  registry.register(getCrossProjectImpactFn);
  registry.register(findStaleProjectsFn);
  registry.register(getDependencyGraphFn);
  registry.register(getClaudeSessionHistoryFn);

  // Researcher functions — research domain knowledge graph queries
  const {
    getLandscapeFn,
    getEntityTimelineFn,
    getTrendingFn,
    getEntityNetworkFn,
    searchEventsFn,
  } = await import('./functions/researcher.js');

  registry.register(getLandscapeFn);
  registry.register(getEntityTimelineFn);
  registry.register(getTrendingFn);
  registry.register(getEntityNetworkFn);
  registry.register(searchEventsFn);

  return registry;
}
