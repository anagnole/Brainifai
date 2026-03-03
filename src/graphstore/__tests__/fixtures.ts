/**
 * Canonical test graph for backend-agnostic tests.
 *
 * 3 persons, 2 containers, 4 topics, 5 activities.
 */
import type { GraphEdge } from '../types.js';

export const PERSONS = [
  { person_key: 'test:alice', display_name: 'Alice', source: 'test', source_id: 'alice' },
  { person_key: 'test:bob', display_name: 'Bob', source: 'test', source_id: 'bob' },
  { person_key: 'test:carol', display_name: 'Carol', source: 'test', source_id: 'carol' },
];

export const CONTAINERS = [
  { source: 'test', container_id: 'general', name: '#general', kind: 'channel' },
  { source: 'test', container_id: 'backend', name: '#backend', kind: 'channel' },
];

export const TOPICS = [
  { name: 'deploy' },
  { name: 'testing' },
  { name: 'performance' },
  { name: 'security' },
];

export const SOURCE_ACCOUNTS = [
  { source: 'test', account_id: 'alice', linked_person_key: 'test:alice' },
  { source: 'test', account_id: 'bob', linked_person_key: 'test:bob' },
  { source: 'test', account_id: 'carol', linked_person_key: 'test:carol' },
];

const now = Date.now();
const hour = 3600 * 1000;

export const ACTIVITIES = [
  {
    source: 'test',
    source_id: 'test:general:1',
    timestamp: new Date(now - 5 * hour).toISOString(),
    kind: 'message',
    snippet: 'Deploy went smoothly today',
    url: null,
    thread_ts: null,
  },
  {
    source: 'test',
    source_id: 'test:general:2',
    timestamp: new Date(now - 4 * hour).toISOString(),
    kind: 'message',
    snippet: 'Testing the new auth flow',
    url: null,
    thread_ts: null,
  },
  {
    source: 'test',
    source_id: 'test:backend:3',
    timestamp: new Date(now - 3 * hour).toISOString(),
    kind: 'message',
    snippet: 'Performance improvements in the query layer',
    url: null,
    thread_ts: null,
  },
  {
    source: 'test',
    source_id: 'test:backend:4',
    timestamp: new Date(now - 2 * hour).toISOString(),
    kind: 'message',
    snippet: 'Security review for the deploy pipeline',
    url: null,
    thread_ts: null,
  },
  {
    source: 'test',
    source_id: 'test:general:5',
    timestamp: new Date(now - 1 * hour).toISOString(),
    kind: 'message',
    snippet: 'Deploy and testing checklist updated',
    url: null,
    thread_ts: null,
  },
];

/** Activity → Person (FROM) edges */
export const FROM_EDGES: GraphEdge[] = [
  { type: 'FROM', fromLabel: 'Activity', toLabel: 'Person', from: { source: 'test', source_id: 'test:general:1' }, to: { person_key: 'test:alice' } },
  { type: 'FROM', fromLabel: 'Activity', toLabel: 'Person', from: { source: 'test', source_id: 'test:general:2' }, to: { person_key: 'test:bob' } },
  { type: 'FROM', fromLabel: 'Activity', toLabel: 'Person', from: { source: 'test', source_id: 'test:backend:3' }, to: { person_key: 'test:carol' } },
  { type: 'FROM', fromLabel: 'Activity', toLabel: 'Person', from: { source: 'test', source_id: 'test:backend:4' }, to: { person_key: 'test:alice' } },
  { type: 'FROM', fromLabel: 'Activity', toLabel: 'Person', from: { source: 'test', source_id: 'test:general:5' }, to: { person_key: 'test:bob' } },
];

/** Activity → Container (IN) edges */
export const IN_EDGES: GraphEdge[] = [
  { type: 'IN', fromLabel: 'Activity', toLabel: 'Container', from: { source: 'test', source_id: 'test:general:1' }, to: { source: 'test', container_id: 'general' } },
  { type: 'IN', fromLabel: 'Activity', toLabel: 'Container', from: { source: 'test', source_id: 'test:general:2' }, to: { source: 'test', container_id: 'general' } },
  { type: 'IN', fromLabel: 'Activity', toLabel: 'Container', from: { source: 'test', source_id: 'test:backend:3' }, to: { source: 'test', container_id: 'backend' } },
  { type: 'IN', fromLabel: 'Activity', toLabel: 'Container', from: { source: 'test', source_id: 'test:backend:4' }, to: { source: 'test', container_id: 'backend' } },
  { type: 'IN', fromLabel: 'Activity', toLabel: 'Container', from: { source: 'test', source_id: 'test:general:5' }, to: { source: 'test', container_id: 'general' } },
];

/** Activity → Topic (MENTIONS) edges */
export const MENTIONS_EDGES: GraphEdge[] = [
  { type: 'MENTIONS', fromLabel: 'Activity', toLabel: 'Topic', from: { source: 'test', source_id: 'test:general:1' }, to: { name: 'deploy' } },
  { type: 'MENTIONS', fromLabel: 'Activity', toLabel: 'Topic', from: { source: 'test', source_id: 'test:general:2' }, to: { name: 'testing' } },
  { type: 'MENTIONS', fromLabel: 'Activity', toLabel: 'Topic', from: { source: 'test', source_id: 'test:backend:3' }, to: { name: 'performance' } },
  { type: 'MENTIONS', fromLabel: 'Activity', toLabel: 'Topic', from: { source: 'test', source_id: 'test:backend:4' }, to: { name: 'security' } },
  { type: 'MENTIONS', fromLabel: 'Activity', toLabel: 'Topic', from: { source: 'test', source_id: 'test:backend:4' }, to: { name: 'deploy' } },
  { type: 'MENTIONS', fromLabel: 'Activity', toLabel: 'Topic', from: { source: 'test', source_id: 'test:general:5' }, to: { name: 'deploy' } },
  { type: 'MENTIONS', fromLabel: 'Activity', toLabel: 'Topic', from: { source: 'test', source_id: 'test:general:5' }, to: { name: 'testing' } },
];

/** SourceAccount → Person (IDENTIFIES) edges */
export const IDENTIFIES_EDGES: GraphEdge[] = [
  { type: 'IDENTIFIES', fromLabel: 'SourceAccount', toLabel: 'Person', from: { source: 'test', account_id: 'alice' }, to: { person_key: 'test:alice' } },
  { type: 'IDENTIFIES', fromLabel: 'SourceAccount', toLabel: 'Person', from: { source: 'test', account_id: 'bob' }, to: { person_key: 'test:bob' } },
  { type: 'IDENTIFIES', fromLabel: 'SourceAccount', toLabel: 'Person', from: { source: 'test', account_id: 'carol' }, to: { person_key: 'test:carol' } },
];

/** SourceAccount → Activity (OWNS) edges */
export const OWNS_EDGES: GraphEdge[] = [
  { type: 'OWNS', fromLabel: 'SourceAccount', toLabel: 'Activity', from: { source: 'test', account_id: 'alice' }, to: { source: 'test', source_id: 'test:general:1' } },
  { type: 'OWNS', fromLabel: 'SourceAccount', toLabel: 'Activity', from: { source: 'test', account_id: 'bob' }, to: { source: 'test', source_id: 'test:general:2' } },
  { type: 'OWNS', fromLabel: 'SourceAccount', toLabel: 'Activity', from: { source: 'test', account_id: 'carol' }, to: { source: 'test', source_id: 'test:backend:3' } },
  { type: 'OWNS', fromLabel: 'SourceAccount', toLabel: 'Activity', from: { source: 'test', account_id: 'alice' }, to: { source: 'test', source_id: 'test:backend:4' } },
  { type: 'OWNS', fromLabel: 'SourceAccount', toLabel: 'Activity', from: { source: 'test', account_id: 'bob' }, to: { source: 'test', source_id: 'test:general:5' } },
];
