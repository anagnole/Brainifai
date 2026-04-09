/**
 * Researcher ingestion pipeline orchestrator.
 *
 * Phases:
 * 1. Config     — read Twitter config from env vars
 * 2. Auth       — verify Twitter session cookies
 * 3. Fetch      — fetch & normalize tweets (user timelines + search queries)
 * 4. Upsert     — upsert Activity/Person/Topic/Container nodes into the DB
 * 5. Extract    — LLM extraction of entities/events/trends (optional)
 * 6. FTS        — rebuild full-text search indexes
 */

import { KuzuGraphStore } from '../../graphstore/kuzu/adapter.js';
import { ResearcherGraphStore } from '../../graphstore/kuzu/researcher-adapter.js';
import { getTwitterConfig } from '../twitter/config.js';
import { getTwitterClient, verifyAuth, fetchUserTweets, fetchSearchResults } from '../twitter/client.js';
import { normalizeTweet } from '../twitter/normalize.js';
import { upsertBatch } from '../upsert.js';
import { extractAndUpsertResearcherData } from '../researcher/index.js';
import { UPSERT_BATCH_SIZE } from '../../shared/constants.js';
import type { NormalizedMessage } from '../../shared/types.js';

// ─── Public types ───────────────────────────────────────────────────────────

export interface ResearcherIngestOptions {
  dbPath: string;
  domain?: string;     // e.g. "artificial intelligence"
  verbose?: boolean;
  force?: boolean;
  extractOnly?: boolean;  // skip fetching, run extraction on existing tweets
}

export interface ResearcherIngestionStats {
  tweets: number;
  entities: number;
  events: number;
  trends: number;
  durationMs: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(verbose: boolean, msg: string) {
  if (verbose) console.error(`[researcher] ${msg}`);
}

// ─── Main pipeline ──────────────────────────────────────────────────────────

export async function runResearcherIngestion(opts: ResearcherIngestOptions): Promise<ResearcherIngestionStats> {
  const startMs = Date.now();
  const { dbPath, domain = 'general', verbose = false, force = false, extractOnly = false } = opts;

  // Open ONE Kuzu Database, then share its connection between the base and
  // researcher adapters. Opening two Database instances on the same file
  // causes multi-writer race conditions and silent data loss.
  const baseStore = new KuzuGraphStore({ dbPath, readOnly: false });
  await baseStore.initialize();

  const researchStore = new ResearcherGraphStore({ conn: baseStore.getConnection() });
  await researchStore.initialize();

  if (force) {
    log(verbose, 'Force mode: clearing existing researcher data...');
    await researchStore.clearData();
  }

  try {
    // ── Extract-only mode: run extraction on existing tweets in the DB ───────
    if (extractOnly) {
      log(verbose, 'Extract-only mode: loading existing tweets from DB...');
      const existing = await baseStore.findNodes('Activity', { source: 'twitter' }, { limit: 10000 });
      const activities: NormalizedMessage[] = existing.map((n) => ({
        activity: {
          source: n.properties.source as string,
          source_id: n.properties.source_id as string,
          timestamp: n.properties.timestamp as string,
          kind: n.properties.kind as string,
          snippet: n.properties.snippet as string,
        },
        person: { person_key: '', display_name: '', source: 'twitter', source_id: '' },
        container: { source: 'twitter', container_id: '', name: '', kind: 'user_timeline' },
        account: { source: 'twitter', account_id: '', linked_person_key: '' },
        topics: [],
      }));

      log(verbose, `  Found ${activities.length} existing tweets`);

      if (activities.length === 0) {
        log(verbose, 'No tweets found — nothing to extract');
        return { tweets: 0, entities: 0, events: 0, trends: 0, durationMs: Date.now() - startMs };
      }

      log(verbose, 'Running LLM extraction (via Claude CLI)...');
      let entitiesCount = 0, eventsCount = 0, trendsCount = 0;
      try {
        const extractionResult = await extractAndUpsertResearcherData(activities, domain, researchStore);
        entitiesCount = extractionResult.entitiesCount;
        eventsCount = extractionResult.eventsCount;
        trendsCount = extractionResult.trendsCount;
        log(verbose, `  Extracted: ${entitiesCount} entities, ${eventsCount} events, ${trendsCount} trends`);
      } catch (err) {
        log(verbose, `  Extraction failed — ${err instanceof Error ? err.message : String(err)}`);
      }

      log(verbose, 'Rebuilding FTS indexes...');
      try {
        await researchStore.rebuildFtsIndexes();
        log(verbose, '  FTS indexes rebuilt');
      } catch (err) {
        log(verbose, `  FTS rebuild failed — ${err instanceof Error ? err.message : String(err)}`);
      }

      return {
        tweets: activities.length,
        entities: entitiesCount,
        events: eventsCount,
        trends: trendsCount,
        durationMs: Date.now() - startMs,
      };
    }

    // ── Phase 1: Config ──────────────────────────────────────────────────────
    log(verbose, 'Phase 1: Reading Twitter config...');
    const twitterConfig = getTwitterConfig();
    log(verbose, `  Usernames: ${twitterConfig.usernames.join(', ') || '(none)'}`);
    log(verbose, `  Search queries: ${twitterConfig.searchQueries.join(', ') || '(none)'}`);

    // ── Phase 2: Auth ────────────────────────────────────────────────────────
    log(verbose, 'Phase 2: Verifying Twitter auth...');
    const client = getTwitterClient(twitterConfig.cookies);
    const testUser = twitterConfig.usernames[0];
    await verifyAuth(client, testUser);
    log(verbose, '  Auth verified');

    // ── Phase 3: Fetch & Normalize ───────────────────────────────────────────
    log(verbose, 'Phase 3: Fetching and normalizing tweets...');
    const allNormalized: NormalizedMessage[] = [];

    for (const username of twitterConfig.usernames) {
      // Use cursor-based incremental fetching from the researcher DB
      const cursorKey = `twitter:user:${username}`;
      const existingCursor = await baseStore.getCursor('twitter', cursorKey);

      const since = existingCursor
        ? new Date(existingCursor)
        : new Date(Date.now() - twitterConfig.backfillDays * 24 * 60 * 60 * 1000);

      log(verbose, `  @${username}: fetching since ${since.toISOString()}`);

      let latestTs = existingCursor ?? '';
      let userTweetCount = 0;

      for await (const page of fetchUserTweets(client, username, since)) {
        for (const raw of page) {
          const normalized = normalizeTweet(raw, username, 'user_timeline', twitterConfig.topicAllowlist);
          if (normalized) {
            allNormalized.push(normalized);
            userTweetCount++;
            if (raw.created_at > latestTs) latestTs = raw.created_at;
          }
        }
      }

      // Persist cursor in the researcher DB
      if (latestTs && latestTs !== existingCursor) {
        await baseStore.setCursor('twitter', cursorKey, latestTs);
      }

      log(verbose, `  @${username}: ${userTweetCount} tweets`);
    }

    for (const query of twitterConfig.searchQueries) {
      const cursorKey = `twitter:search:${query}`;
      const existingCursor = await baseStore.getCursor('twitter', cursorKey);

      const since = existingCursor
        ? new Date(existingCursor)
        : new Date(Date.now() - twitterConfig.backfillDays * 24 * 60 * 60 * 1000);

      log(verbose, `  search "${query}": fetching since ${since.toISOString()}`);

      let latestTs = existingCursor ?? '';
      let searchTweetCount = 0;

      for await (const page of fetchSearchResults(client, query, since)) {
        for (const raw of page) {
          const normalized = normalizeTweet(raw, query, 'search', twitterConfig.topicAllowlist);
          if (normalized) {
            allNormalized.push(normalized);
            searchTweetCount++;
            if (raw.created_at > latestTs) latestTs = raw.created_at;
          }
        }
      }

      if (latestTs && latestTs !== existingCursor) {
        await baseStore.setCursor('twitter', cursorKey, latestTs);
      }

      log(verbose, `  search "${query}": ${searchTweetCount} tweets`);
    }

    log(verbose, `  Total normalized tweets: ${allNormalized.length}`);

    if (allNormalized.length === 0) {
      log(verbose, 'No new tweets found — skipping upsert and extraction');
      return { tweets: 0, entities: 0, events: 0, trends: 0, durationMs: Date.now() - startMs };
    }

    // ── Phase 4: Upsert base data ────────────────────────────────────────────
    log(verbose, 'Phase 4: Upserting base data (Activity, Person, Topic, Container)...');
    for (let i = 0; i < allNormalized.length; i += UPSERT_BATCH_SIZE) {
      const batch = allNormalized.slice(i, i + UPSERT_BATCH_SIZE);
      await upsertBatch(baseStore, batch);
    }
    log(verbose, `  Upserted ${allNormalized.length} activities`);

    // ── Phase 5: LLM Extraction (optional) ───────────────────────────────────
    let entitiesCount = 0;
    let eventsCount = 0;
    let trendsCount = 0;

    log(verbose, 'Phase 5: Running LLM extraction (via Claude CLI)...');
    try {
      const extractionResult = await extractAndUpsertResearcherData(
        allNormalized,
        domain,
        researchStore,
      );
      entitiesCount = extractionResult.entitiesCount;
      eventsCount = extractionResult.eventsCount;
      trendsCount = extractionResult.trendsCount;
      log(verbose, `  Extracted: ${entitiesCount} entities, ${eventsCount} events, ${trendsCount} trends`);
    } catch (err) {
      log(verbose, `  Extraction failed — ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Phase 6: FTS Indexes ─────────────────────────────────────────────────
    log(verbose, 'Phase 6: Rebuilding FTS indexes...');
    await baseStore.rebuildFtsIndexes();
    await researchStore.rebuildFtsIndexes();
    log(verbose, '  FTS indexes rebuilt');

    const stats: ResearcherIngestionStats = {
      tweets: allNormalized.length,
      entities: entitiesCount,
      events: eventsCount,
      trends: trendsCount,
      durationMs: Date.now() - startMs,
    };
    log(verbose, 'Ingestion complete.');
    return stats;
  } finally {
    await researchStore.close();
    await baseStore.close();
  }
}
