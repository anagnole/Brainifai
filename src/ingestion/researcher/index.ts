/**
 * Researcher extraction orchestration.
 *
 * Splits activities into batches, extracts structured knowledge via Claude Haiku,
 * and upserts the results into the researcher schema.
 */

import { logger } from '../../shared/logger.js';
import type { NormalizedMessage } from '../../shared/types.js';
import type { ResearcherGraphStore } from '../../graphstore/kuzu/researcher-adapter.js';
import { extractFromBatch, EXTRACTION_BATCH_SIZE } from './extract.js';
import { upsertExtractionResult } from './upsert-researcher.js';

export { EXTRACTION_BATCH_SIZE } from './extract.js';
export type { ExtractionResult } from './extract.js';

/**
 * Extract structured knowledge from activities and upsert into the researcher schema.
 * Splits into batches of EXTRACTION_BATCH_SIZE, calls the LLM, then upserts.
 */
export async function extractAndUpsertResearcherData(
  activities: NormalizedMessage[],
  domain: string,
  store: ResearcherGraphStore,
): Promise<{ entitiesCount: number; eventsCount: number; trendsCount: number }> {
  const totals = { entitiesCount: 0, eventsCount: 0, trendsCount: 0 };

  if (activities.length === 0) return totals;

  // Split into batches
  const batches: NormalizedMessage[][] = [];
  for (let i = 0; i < activities.length; i += EXTRACTION_BATCH_SIZE) {
    batches.push(activities.slice(i, i + EXTRACTION_BATCH_SIZE));
  }

  logger.info(
    { activityCount: activities.length, batchCount: batches.length, domain },
    'Starting researcher extraction',
  );

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    logger.info(
      { batch: batchIdx + 1, of: batches.length, size: batch.length },
      'Extracting batch',
    );

    const result = await extractFromBatch(batch, domain);

    const sourceIds = batch.map((a) => a.activity.source_id);
    const counts = await upsertExtractionResult(result, sourceIds, domain, store);

    totals.entitiesCount += counts.entitiesCount;
    totals.eventsCount += counts.eventsCount;
    totals.trendsCount += counts.trendsCount;

    logger.info(
      { batch: batchIdx + 1, entities: counts.entitiesCount, events: counts.eventsCount, trends: counts.trendsCount },
      'Batch extraction complete',
    );
  }

  logger.info(
    { entities: totals.entitiesCount, events: totals.eventsCount, trends: totals.trendsCount },
    'Researcher extraction complete',
  );

  return totals;
}
