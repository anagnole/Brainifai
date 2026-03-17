# Audit 004 — Ingestion Pipeline

**Date**: 2026-03-12
**Scope**: `src/ingestion/` — orchestration, cursors, upsert, normalization, topic extraction, all connectors (Slack, GitHub, ClickUp, Apple Calendar, Claude Code)

---

## Summary

The ingestion pipeline is well-architected with strong idempotency guarantees, proper error isolation between connectors, and consistent normalization across five data sources. The core design — MERGE-based upserts, cursor-gated incremental fetches, and `Promise.allSettled` for fault isolation — is solid. There are a few cursor-safety issues and data gaps worth addressing, but nothing that risks data corruption.

---

## Strengths

1. **Fault isolation via `Promise.allSettled`** (`index.ts:430`). A Slack outage does not block GitHub or ClickUp ingestion. Each connector failure is logged and reported independently, and the status file records partial success.

2. **Full idempotency**. All node and edge writes use `MERGE` in Kuzu (`adapter.ts:529, 567`). Re-running `npm run ingest` against the same data window produces no duplicates. The `activitiesMap` dedup in `upsert.ts:64` adds a second layer of protection within a batch.

3. **Consistent normalization contract**. Every connector produces the same `NormalizedMessage` shape. The `upsertBatch` function handles all five sources identically — Person, Container, SourceAccount, Activity, Topic nodes plus typed edges.

4. **Graceful degradation in ClickUp**. The `activitySupported` flag (`index.ts:177-211`) probes the activity endpoint once and disables it for the rest of the run if the plan does not support it. Docs ingestion is wrapped in a separate try/catch (`index.ts:229-263`).

5. **Claude Code summarization with fallback**. LLM summarization degrades to a metadata-based fallback if the API key is missing or the call fails (`summarize.ts:98-120`), so ingestion never blocks on an external LLM.

6. **Topic extraction is allowlist-gated**. The `extractAnnotations` function uses word-boundary-safe regex matching against a curated allowlist plus hashtag extraction, avoiding garbage topics from arbitrary substrings.

---

## Issues

### Critical

*None identified.*

### Important

**I-1. Apple Calendar cursor is advanced unconditionally** (severity: important)
`index.ts:287` calls `setCursor` with `new Date().toISOString()` regardless of whether `upsertBatch` succeeded or even ran. If the upsert throws mid-batch, the cursor advances past un-ingested events, causing permanent data loss on that window. Every other connector correctly guards cursor advancement with `if (latestTs !== since)` and only advances to the latest *successfully processed* timestamp.

**I-2. Slack cursor advances after all pages, not per-page** (severity: important)
In `ingestSlack` (`index.ts:68-69`), the cursor is updated only after *all* pages for a channel have been processed. If the process crashes mid-pagination (e.g., page 5 of 10), the cursor is never advanced and the entire channel is re-fetched from the original cursor on the next run. While MERGE prevents duplicates, this wastes API calls and time. The same pattern appears in GitHub and ClickUp — cursor is set after the full loop.

**I-3. GitHub PR reviews are re-fetched on every updated PR** (severity: important)
`index.ts:107-111` fetches all reviews for every PR in the page, even if only the PR's `updated_at` changed (e.g., a label was added). Reviews are not filtered by the cursor timestamp, so previously ingested reviews are re-fetched and re-upserted every run. For repos with many PRs, this is an N+1 API call problem that scales poorly.

**I-4. ClickUp comments are re-fetched for every updated task** (severity: important)
`index.ts:190-198` fetches all comments for every task returned by the `fetchTasks` endpoint on every run. There is no cursor or timestamp filter on comments — all comments are re-fetched and re-upserted. Same N+1 pattern as GitHub reviews.

**I-5. Slack threads are not explicitly fetched** (severity: important)
`conversations.history` returns only top-level messages and the thread root. Thread replies require a separate `conversations.replies` call per thread. The pipeline captures thread roots and stores `thread_ts` / `parent_source_id`, but never fetches the actual reply messages. This is a known data gap — threaded conversations (common in Slack) are represented only by their root message.

### Nice-to-have

**N-1. GitHub issue comments are not ingested** (severity: nice-to-have)
The `fetchPRComments` function explicitly filters to PR comments only (`client.ts:83`: `c.html_url.includes('/pull/')`). Issue comments are silently dropped. If issue discussions are valuable to the knowledge graph, a separate connector path would be needed.

**N-2. Slack person display names are user IDs** (severity: nice-to-have)
`normalize.ts:57` sets `display_name: msg.user`, which is the Slack user ID (e.g., `U12345`), not a human-readable name. The `users.info` API would be needed to resolve real names. The code comments acknowledge this ("will be enriched later if needed") but no enrichment step exists.

**N-3. ClickUp doc creator display name is the person key** (severity: nice-to-have)
`clickup/normalize.ts:178` sets `display_name: personKey` (e.g., `clickup:12345`) because the docs API only returns a creator ID, not user metadata. This produces ugly display names in queries.

**N-4. Claude Code LLM-extracted topics bypass the allowlist** (severity: nice-to-have)
In `claude-code/normalize.ts:24`, the LLM-generated `result.topics` are merged directly into the topic set without allowlist filtering. The allowlist is applied to `extractAnnotations` on the summary text, but the LLM's own topic suggestions (from the "Topics: ..." line) are unfiltered. This can introduce noisy or inconsistent topic names (e.g., "bug-fixing" vs "bugfix" vs "debugging").

**N-5. ClickUp task statuses are ingested as topics** (severity: nice-to-have)
`clickup/normalize.ts:38` adds the task status (e.g., "in-progress", "complete") as a topic. Status change normalization (`normalizeClickUpStatusChange`) also adds both `before` and `after` statuses as topics. This pollutes the Topic namespace with workflow states that are not conceptual topics, potentially creating noise in topic-based queries.

**N-6. No retry/backoff in ClickUp client** (severity: nice-to-have)
The Slack client has `retryConfig: { retries: 3 }` and the GitHub client uses Octokit's built-in retry. The ClickUp client (`clickup/client.ts`) is a raw `fetch` wrapper with no retry logic. A transient 429 or 500 from the ClickUp API will immediately fail the entire ClickUp connector.

---

## Recommendations

1. **Fix Apple Calendar cursor safety** (I-1). Track `latestTs` from successfully processed events and only advance the cursor to that value, matching the pattern used by all other connectors.

2. **Add Slack thread reply fetching** (I-5). After processing `conversations.history`, iterate over messages with `reply_count > 0` and call `conversations.replies` for each. This is the highest-impact data gap.

3. **Filter GitHub reviews by submission date** (I-3). Skip reviews with `submitted_at <= prSince` to avoid re-processing. Alternatively, track a separate cursor for reviews.

4. **Add per-page cursor advancement** (I-2). Consider advancing the cursor after each successful page + upsert to provide crash resilience. This is lower priority since MERGE prevents duplicates on retry.

5. **Filter Claude Code LLM topics through the allowlist** (N-4). Apply the same allowlist gate to LLM-generated topics, or at minimum normalize them (lowercase, strip hyphens/spaces consistency) before insertion.

6. **Add retry logic to the ClickUp client** (N-6). Wrap fetch calls with exponential backoff for 429/5xx responses, similar to the Slack client's retry configuration.
