import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';
import { initEventBus, closeEventBus } from '../event-bus/index.js';
import { listInstances } from '../instance/registry.js';
import { collectIngestion } from '../ingestion/index.js';
import { classifyBatch } from './classifier.js';
import { buildRoutingPlan } from './router.js';
import { deliverToInstance } from './delivery.js';
import { upsertBatch } from '../ingestion/upsert.js';
import { logger } from '../shared/logger.js';
import type { OrchestratorConfig, InstanceContext } from './types.js';
import {
  ORCHESTRATOR_BATCH_SIZE,
  ORCHESTRATOR_MODEL,
  ORCHESTRATOR_CONFIDENCE_THRESHOLD,
} from '../shared/constants.js';

async function main() {
  process.env.GRAPHSTORE_READONLY = 'false';
  const store = await getGraphStore();
  await store.initialize();
  await initEventBus();

  const config: OrchestratorConfig = {
    apiKey: process.env.ANTHROPIC_API_KEY!,
    model: ORCHESTRATOR_MODEL,
    batchSize: ORCHESTRATOR_BATCH_SIZE,
    confidenceThreshold: ORCHESTRATOR_CONFIDENCE_THRESHOLD,
  };

  if (!config.apiKey) {
    logger.error('ANTHROPIC_API_KEY required for orchestrator mode');
    process.exit(1);
  }

  // 1. Get all active child instances from registry
  const registryEntries = await listInstances({ status: 'active' });
  const children: InstanceContext[] = registryEntries
    .filter(e => e.name !== 'global')
    .map(e => ({ name: e.name, type: e.type, description: e.description }));

  if (children.length === 0) {
    logger.info('No child instances registered — running standard ingestion (all to global)');
  }

  // 2. Collect all ingested data (no upsert yet)
  const allMessages = await collectIngestion(store);
  logger.info({ count: allMessages.length }, 'Collected messages from all sources');

  if (allMessages.length === 0) {
    logger.info('No new data to process');
    await closeEventBus();
    await closeGraphStore();
    return;
  }

  // 3. Classify in batches and route
  let totalGlobal = 0;
  const deliveryCounts = new Map<string, number>();

  for (let i = 0; i < allMessages.length; i += config.batchSize) {
    const batch = allMessages.slice(i, i + config.batchSize);

    let classification;
    if (children.length === 0) {
      // No children — skip AI, everything goes to global
      classification = {
        results: batch.map(msg => ({
          message: msg,
          decision: { targets: [] as string[], confidence: 1, reason: 'No children registered' },
        })),
        errors: [] as Array<{ message: typeof batch[0]; error: string }>,
      };
    } else {
      classification = await classifyBatch(batch, children, config);
    }

    // 4. Build routing plan (handles fanout)
    const plan = buildRoutingPlan(classification);

    // 5. Deliver to children via event bus
    for (const [target, messages] of plan.targeted) {
      await deliverToInstance(target, messages);
      deliveryCounts.set(target, (deliveryCounts.get(target) ?? 0) + messages.length);
    }

    // 6. Upsert global fallback directly
    if (plan.global.length > 0) {
      await upsertBatch(store, plan.global);
      totalGlobal += plan.global.length;
    }

    logger.info({
      batchIndex: Math.floor(i / config.batchSize),
      targeted: plan.targeted.size,
      global: plan.global.length,
    }, 'Processed batch');
  }

  // Summary
  console.log(`Orchestrator complete: ${allMessages.length} messages processed`);
  console.log(`  Global: ${totalGlobal}`);
  for (const [target, count] of deliveryCounts) {
    console.log(`  → ${target}: ${count}`);
  }

  await closeEventBus();
  await closeGraphStore();
}

main().catch(async (err) => {
  logger.error(err, 'Orchestrator failed');
  console.error('Orchestrator failed:', err.message);
  await closeEventBus();
  await closeGraphStore();
  process.exit(1);
});
