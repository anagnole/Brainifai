import { searchCodeFn, getSymbolContextFn, getBlastRadiusFn }
  from '../context/functions/coding-bridge.js';
import type { GraphStore } from '../../src/graphstore/types.js';

// Stub store — enrichFromBrainifai will return [] but GitNexus calls fire live
const stub = {
  getRecentActivity: async () => [],
  initialize: async () => {}, close: async () => {},
  getNode: async () => null, findNodes: async () => [], search: async () => [],
  neighborhood: async () => ({ nodes: [], edges: [] }),
  expand: async () => [], timeline: async () => [], timelineMulti: async () => [],
  upsertNodes: async () => {}, upsertEdges: async () => {},
  getCursor: async () => null, setCursor: async () => {}, getEntitySummary: async () => null,
} as unknown as GraphStore;

async function main() {
  console.log('── search_code ──────────────────────────────────────────────');
  const r1 = await searchCodeFn.execute({ query: 'GraphStore', repo: 'Brainifai', limit: 2 }, stub) as any;
  console.log('processes:', r1.processes.map((p: any) => p.summary));
  console.log('symbols (first 3):', r1.symbols.slice(0, 3).map((s: any) => s.name));

  console.log('\n── get_symbol_context ───────────────────────────────────────');
  const r2 = await getSymbolContextFn.execute({ symbol: 'getGraphStore', repo: 'Brainifai' }, stub) as any;
  console.log('symbol:', r2.symbol?.name, '@', r2.symbol?.filePath);
  console.log('callers (first 3):', r2.callers?.slice(0, 3).map((c: any) => c.name));

  console.log('\n── get_blast_radius ─────────────────────────────────────────');
  const r3 = await getBlastRadiusFn.execute({ target: 'getGraphStore', repo: 'Brainifai', depth: 2 }, stub) as any;
  console.log('risk:', r3.risk, '| impacted:', r3.impacted_count);
  console.log('modules:', r3.affected_modules.map((m: any) => `${m.name}(×${m.hits})`).join(', '));

  console.log('\n✅ All live calls succeeded.');
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
