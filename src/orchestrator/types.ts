import type { NormalizedMessage } from '../shared/types.js';

/** A single routing decision for one piece of data */
export interface RoutingDecision {
  /** Target instance names (e.g. ["aballos", "alfred"]) — empty = global fallback */
  targets: string[];
  /** Confidence score 0-1 for the routing decision */
  confidence: number;
  /** Brief reason for routing (for debugging/logging) */
  reason: string;
}

/** A batch of routing decisions paired with their data */
export interface RoutingResult {
  /** Original message */
  message: NormalizedMessage;
  /** Where it should go */
  decision: RoutingDecision;
}

/** Complete batch output from the classifier */
export interface ClassificationBatch {
  results: RoutingResult[];
  /** Messages that failed classification — fall back to global */
  errors: Array<{ message: NormalizedMessage; error: string }>;
}

/** Instance context provided to the classifier */
export interface InstanceContext {
  name: string;
  type: string;
  description: string;
}

/** Orchestrator configuration */
export interface OrchestratorConfig {
  apiKey: string;
  model: string;
  batchSize: number;
  confidenceThreshold: number; // below this → global fallback
}
