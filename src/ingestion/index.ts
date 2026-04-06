import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { getGraphStore, getGlobalGraphStore, closeGraphStore } from '../shared/graphstore.js';
import { UPSERT_BATCH_SIZE } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import { getSlackConfig } from './slack/config.js';
import { getSlackClient, verifyAuth, fetchChannelInfo, fetchChannelHistory } from './slack/client.js';
import { normalizeSlackMessage } from './normalize.js';
import { getCursor, setCursor } from './cursor.js';
import { upsertBatch } from './upsert.js';
import type { NormalizedMessage } from '../shared/types.js';
import type { GraphStore } from '../graphstore/types.js';
import { getGitHubConfig } from './github/config.js';
import { getGitHubClient, verifyAuth as verifyGitHubAuth, fetchPRs, fetchPRComments, fetchPRReviews } from './github/client.js';
import { normalizeGitHubPR, normalizeGitHubComment, normalizeGitHubReview } from './github/normalize.js';
import { getClickUpConfig } from './clickup/config.js';
import { getClickUpClient, verifyAuth as verifyClickUpAuth, getListInfo, fetchTasks, fetchComments, fetchTaskActivity, fetchDocs } from './clickup/client.js';
import { normalizeClickUpTask, normalizeClickUpComment, normalizeClickUpStatusChange, normalizeClickUpDoc } from './clickup/normalize.js';
import { getAppleCalendarConfig } from './apple-calendar/config.js';
import { fetchCalendarEvents } from './apple-calendar/client.js';
import { normalizeCalendarEvent } from './apple-calendar/normalize.js';
import { existsSync } from 'fs';
import { linkPersons } from './person-linker.js';
import { getClaudeCodeConfig } from './claude-code/config.js';
import { discoverProjects, listSessionFiles, parseSessionFile } from './claude-code/client.js';
import { summarizeSession, fallbackSummary } from './claude-code/summarize.js';
import { normalizeSession } from './claude-code/normalize.js';
import { getTwitterConfig } from './twitter/config.js';
import { getTwitterClient, verifyAuth as verifyTwitterAuth, fetchUserTweets, fetchSearchResults } from './twitter/client.js';
import { normalizeTweet } from './twitter/normalize.js';
import { extractAndUpsertResearcherData } from './researcher/index.js';
import { ResearcherGraphStore } from '../graphstore/kuzu/researcher-adapter.js';
import { findInstancesByType } from '../instance/registry.js';
import { readInstanceConfig } from '../instance/resolve.js';

async function ingestSlack(store: GraphStore) {
  const config = getSlackConfig();
  const slack = getSlackClient(config.token);

  await verifyAuth(slack);

  for (const channelId of config.channelIds) {
    const channelInfo = await fetchChannelInfo(slack, channelId);
    logger.info({ channel: channelInfo.name, id: channelId }, 'Processing channel');

    const cursor = await getCursor(store, 'slack', channelId);
    const oldest = cursor ?? String(
      (Date.now() / 1000) - config.backfillDays * 86400,
    );

    let totalIngested = 0;
    let latestTs = oldest;

    for await (const page of fetchChannelHistory(slack, channelId, oldest)) {
      const normalized: NormalizedMessage[] = [];

      for (const msg of page) {
        const result = normalizeSlackMessage(
          msg,
          channelInfo,
          config.topicAllowlist,
        );
        if (result) {
          normalized.push(result);
          if (msg.ts > latestTs) latestTs = msg.ts;
        }
      }

      for (let i = 0; i < normalized.length; i += UPSERT_BATCH_SIZE) {
        await upsertBatch(store, normalized.slice(i, i + UPSERT_BATCH_SIZE));
      }

      totalIngested += normalized.length;
    }

    if (latestTs !== oldest) {
      await setCursor(store, 'slack', channelId, latestTs);
    }

    console.log(`Slack #${channelInfo.name}: ingested ${totalIngested} messages`);
  }
}

async function ingestGitHub(store: GraphStore) {
  const config = getGitHubConfig();
  const client = getGitHubClient(config.token);

  await verifyGitHubAuth(client);

  const backfillSince = new Date(
    Date.now() - config.backfillDays * 86400 * 1000,
  ).toISOString();

  for (const repoFullName of config.repos) {
    const [owner, repo] = repoFullName.split('/');
    logger.info({ repo: repoFullName }, 'Processing GitHub repo');

    // --- Pull Requests ---
    const prCursorKey = `${repoFullName}:prs`;
    const prSince = (await getCursor(store, 'github', prCursorKey)) ?? backfillSince;
    let prCount = 0;
    let latestPrTs = prSince;

    for await (const page of fetchPRs(client, owner, repo, prSince)) {
      const normalized: NormalizedMessage[] = [];

      for (const pr of page) {
        const item = normalizeGitHubPR(pr, repoFullName, config.topicAllowlist);
        if (item) {
          normalized.push(item);
          if (pr.updated_at > latestPrTs) latestPrTs = pr.updated_at;
        }

        // Fetch reviews for each updated PR
        const reviews = await fetchPRReviews(client, owner, repo, pr.number);
        for (const review of reviews) {
          const reviewItem = normalizeGitHubReview(review, repoFullName, pr.number, config.topicAllowlist);
          if (reviewItem) normalized.push(reviewItem);
        }
      }

      for (let i = 0; i < normalized.length; i += UPSERT_BATCH_SIZE) {
        await upsertBatch(store, normalized.slice(i, i + UPSERT_BATCH_SIZE));
      }

      prCount += page.length;
    }

    if (latestPrTs !== prSince) {
      await setCursor(store, 'github', prCursorKey, latestPrTs);
    }

    // --- PR Comments ---
    const commentCursorKey = `${repoFullName}:comments`;
    const commentSince = (await getCursor(store, 'github', commentCursorKey)) ?? backfillSince;
    let commentCount = 0;
    let latestCommentTs = commentSince;

    for await (const page of fetchPRComments(client, owner, repo, commentSince)) {
      const normalized: NormalizedMessage[] = [];

      for (const comment of page) {
        const item = normalizeGitHubComment(comment, repoFullName, config.topicAllowlist);
        if (item) {
          normalized.push(item);
          if (comment.created_at > latestCommentTs) latestCommentTs = comment.created_at;
        }
      }

      for (let i = 0; i < normalized.length; i += UPSERT_BATCH_SIZE) {
        await upsertBatch(store, normalized.slice(i, i + UPSERT_BATCH_SIZE));
      }

      commentCount += page.length;
    }

    if (latestCommentTs !== commentSince) {
      await setCursor(store, 'github', commentCursorKey, latestCommentTs);
    }

    console.log(`GitHub ${repoFullName}: ingested ${prCount} PRs, ${commentCount} comments`);
  }
}

async function ingestClickUp(store: GraphStore) {
  const config = getClickUpConfig();
  const client = getClickUpClient(config.token);

  const { workspaceId, workspaceName } = await verifyClickUpAuth(client);

  const backfillSince = new Date(
    Date.now() - config.backfillDays * 86400 * 1000,
  ).toISOString();

  // --- Tasks & Comments (per list) ---
  for (const listId of config.listIds) {
    const listInfo = await getListInfo(client, listId);
    logger.info({ list: listInfo.name, id: listId }, 'Processing ClickUp list');

    const taskCursorKey = `${listId}:tasks`;
    const taskSince = (await getCursor(store, 'clickup', taskCursorKey)) ?? backfillSince;
    let taskCount = 0;
    let commentCount = 0;
    let latestTaskTs = taskSince;
    let activitySupported = true; // probe once; disable for rest of run if 404

    for await (const page of fetchTasks(client, listId, taskSince)) {
      const normalized: NormalizedMessage[] = [];

      for (const task of page) {
        const item = normalizeClickUpTask(task, listId, listInfo.name, config.topicAllowlist);
        if (item) {
          normalized.push(item);
          if (task.date_updated > latestTaskTs) latestTaskTs = task.date_updated;
        }

        // Fetch comments for each task
        const taskSourceId = `clickup:${listId}:task:${task.id}`;
        const comments = await fetchComments(client, task.id);
        for (const comment of comments) {
          const commentItem = normalizeClickUpComment(comment, listId, listInfo.name, config.topicAllowlist, taskSourceId);
          if (commentItem) {
            normalized.push(commentItem);
            commentCount++;
          }
        }

        // Fetch status change history — skip if endpoint not available on this plan
        if (activitySupported) {
          const activities = await fetchTaskActivity(client, task.id);
          if (activities === null) {
            activitySupported = false;
          } else {
            for (const activity of activities) {
              const statusItem = normalizeClickUpStatusChange(activity, task, listId, listInfo.name);
              if (statusItem) normalized.push(statusItem);
            }
          }
        }
      }

      for (let i = 0; i < normalized.length; i += UPSERT_BATCH_SIZE) {
        await upsertBatch(store, normalized.slice(i, i + UPSERT_BATCH_SIZE));
      }

      taskCount += page.length;
    }

    if (latestTaskTs !== taskSince) {
      await setCursor(store, 'clickup', taskCursorKey, latestTaskTs);
    }

    console.log(`ClickUp ${listInfo.name}: ingested ${taskCount} tasks, ${commentCount} comments`);
  }

  // --- Docs (per workspace) ---
  try {
    const docCursorKey = `${workspaceId}:docs`;
    const docSince = (await getCursor(store, 'clickup', docCursorKey)) ?? backfillSince;
    let docCount = 0;
    let latestDocTs = docSince;

    for await (const page of fetchDocs(client, workspaceId)) {
      const normalized: NormalizedMessage[] = [];

      for (const doc of page) {
        const docTs = new Date(Number(doc.date_updated)).toISOString();
        if (docTs <= docSince) continue;

        const item = normalizeClickUpDoc(doc, workspaceId, workspaceName, config.topicAllowlist);
        if (item) {
          normalized.push(item);
          if (docTs > latestDocTs) latestDocTs = docTs;
          docCount++;
        }
      }

      for (let i = 0; i < normalized.length; i += UPSERT_BATCH_SIZE) {
        await upsertBatch(store, normalized.slice(i, i + UPSERT_BATCH_SIZE));
      }
    }

    if (latestDocTs !== docSince) {
      await setCursor(store, 'clickup', docCursorKey, latestDocTs);
    }

    console.log(`ClickUp workspace: ingested ${docCount} docs`);
  } catch (err) {
    logger.warn({ err }, 'ClickUp Docs API unavailable — skipping docs ingestion');
    console.log('ClickUp workspace: docs skipped (API not available on this plan)');
  }
}

async function ingestAppleCalendar(store: GraphStore) {
  const config = getAppleCalendarConfig();
  const backfillSince = new Date(
    Date.now() - config.backfillDays * 86400 * 1000,
  ).toISOString();

  const cursorKey = `${config.username}:calendars`;
  const since = (await getCursor(store, 'apple-calendar', cursorKey)) ?? backfillSince;

  const events = await fetchCalendarEvents(config.username, config.password, since, config.calendarFilter);

  const normalized: NormalizedMessage[] = [];
  for (const event of events) {
    const item = normalizeCalendarEvent(event, config.username, config.topicAllowlist);
    if (item) normalized.push(item);
  }

  for (let i = 0; i < normalized.length; i += UPSERT_BATCH_SIZE) {
    await upsertBatch(store, normalized.slice(i, i + UPSERT_BATCH_SIZE));
  }

  await setCursor(store, 'apple-calendar', cursorKey, new Date().toISOString());
  console.log(`Apple Calendar: ingested ${normalized.length} events`);
}

async function ingestClaudeCode(store: GraphStore) {
  const config = getClaudeCodeConfig();

  if (!existsSync(config.projectsPath)) {
    logger.info({ path: config.projectsPath }, 'Claude Code projects path not found — skipping');
    return;
  }

  const backfillSince = new Date(
    Date.now() - config.backfillDays * 86400 * 1000,
  ).toISOString();

  const projectDirs = discoverProjects(config.projectsPath);
  let totalIngested = 0;

  for (const projectDirName of projectDirs) {
    const projectPath = `${config.projectsPath}/${projectDirName}`;
    const cursorKey = projectDirName;
    const cursor = await getCursor(store, 'claude-code', cursorKey);
    const since = cursor ?? backfillSince;
    const sinceDate = new Date(since);

    const sessionFiles = listSessionFiles(projectPath);
    let latestTs = since;

    for (const { path: filePath, mtime } of sessionFiles) {
      // Fast pre-filter: skip files not modified since cursor
      if (mtime <= sinceDate) continue;

      const session = parseSessionFile(filePath, projectDirName);
      if (!session) continue;

      // Skip sessions already ingested (by timestamp)
      if (session.lastTimestamp <= since) continue;

      // Summarize
      let result;
      if (config.anthropicApiKey) {
        try {
          result = await summarizeSession(session, config.anthropicApiKey);
        } catch (err) {
          logger.warn({ sessionId: session.sessionId, err }, 'LLM summarization failed, using fallback');
          result = fallbackSummary(session);
        }
      } else {
        result = fallbackSummary(session);
      }

      const normalized = normalizeSession(session, result, config.userName, config.topicAllowlist);
      await upsertBatch(store, [normalized]);

      if (session.lastTimestamp > latestTs) latestTs = session.lastTimestamp;
      totalIngested++;
    }

    if (latestTs !== since) {
      await setCursor(store, 'claude-code', cursorKey, latestTs);
    }
  }

  console.log(`Claude Code: ingested ${totalIngested} sessions from ${projectDirs.length} projects`);
}

async function ingestTwitter(store: GraphStore) {
  const config = getTwitterConfig();
  const client = getTwitterClient(config.cookies);

  await verifyTwitterAuth(client, config.usernames[0]);

  const backfillSince = new Date(
    Date.now() - config.backfillDays * 86400 * 1000,
  );

  // --- User timelines ---
  for (const username of config.usernames) {
    try {
      logger.info({ username }, 'Processing Twitter user timeline');

      const cursorKey = `${username}:timeline`;
      const cursorVal = await getCursor(store, 'twitter', cursorKey);
      const since = cursorVal ? new Date(cursorVal) : backfillSince;

      let totalIngested = 0;
      let latestTs = cursorVal ?? backfillSince.toISOString();

      for await (const page of fetchUserTweets(client, username, since)) {
        const normalized: NormalizedMessage[] = [];

        for (const tweet of page) {
          const result = normalizeTweet(tweet, username, 'user_timeline', config.topicAllowlist);
          if (result) {
            normalized.push(result);
            if (tweet.created_at > latestTs) latestTs = tweet.created_at;
          }
        }

        for (let i = 0; i < normalized.length; i += UPSERT_BATCH_SIZE) {
          await upsertBatch(store, normalized.slice(i, i + UPSERT_BATCH_SIZE));
        }

        totalIngested += normalized.length;
      }

      if (latestTs !== (cursorVal ?? backfillSince.toISOString())) {
        await setCursor(store, 'twitter', cursorKey, latestTs);
      }

      console.log(`Twitter @${username}: ingested ${totalIngested} tweets`);
    } catch (err) {
      logger.warn({ username, err }, 'Failed to ingest Twitter user — skipping');
      console.error(`Twitter @${username}: SKIPPED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- Search queries ---
  for (const query of config.searchQueries) {
    const safeKey = query.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    logger.info({ query }, 'Processing Twitter search');

    const cursorKey = `search:${safeKey}`;
    const cursorVal = await getCursor(store, 'twitter', cursorKey);
    const since = cursorVal ? new Date(cursorVal) : backfillSince;

    let totalIngested = 0;
    let latestTs = cursorVal ?? backfillSince.toISOString();

    for await (const page of fetchSearchResults(client, query, since)) {
      const normalized: NormalizedMessage[] = [];

      for (const tweet of page) {
        const result = normalizeTweet(tweet, safeKey, 'search', config.topicAllowlist);
        if (result) {
          normalized.push(result);
          if (tweet.created_at > latestTs) latestTs = tweet.created_at;
        }
      }

      for (let i = 0; i < normalized.length; i += UPSERT_BATCH_SIZE) {
        await upsertBatch(store, normalized.slice(i, i + UPSERT_BATCH_SIZE));
      }

      totalIngested += normalized.length;
    }

    if (latestTs !== (cursorVal ?? backfillSince.toISOString())) {
      await setCursor(store, 'twitter', cursorKey, latestTs);
    }

    console.log(`Twitter search "${query}": ingested ${totalIngested} tweets`);
  }
}

// ─── Collect-only variants (for orchestrator mode) ────────────────────────
// These mirror the ingest* functions but return NormalizedMessages instead of upserting.

async function collectSlack(store: GraphStore): Promise<NormalizedMessage[]> {
  const config = getSlackConfig();
  const slack = getSlackClient(config.token);
  await verifyAuth(slack);

  const collected: NormalizedMessage[] = [];

  for (const channelId of config.channelIds) {
    const channelInfo = await fetchChannelInfo(slack, channelId);
    logger.info({ channel: channelInfo.name, id: channelId }, 'Collecting channel');

    const cursor = await getCursor(store, 'slack', channelId);
    const oldest = cursor ?? String((Date.now() / 1000) - config.backfillDays * 86400);
    let latestTs = oldest;

    for await (const page of fetchChannelHistory(slack, channelId, oldest)) {
      for (const msg of page) {
        const result = normalizeSlackMessage(msg, channelInfo, config.topicAllowlist);
        if (result) {
          collected.push(result);
          if (msg.ts > latestTs) latestTs = msg.ts;
        }
      }
    }

    if (latestTs !== oldest) {
      await setCursor(store, 'slack', channelId, latestTs);
    }
  }

  return collected;
}

async function collectGitHub(store: GraphStore): Promise<NormalizedMessage[]> {
  const config = getGitHubConfig();
  const client = getGitHubClient(config.token);
  await verifyGitHubAuth(client);

  const backfillSince = new Date(Date.now() - config.backfillDays * 86400 * 1000).toISOString();
  const collected: NormalizedMessage[] = [];

  for (const repoFullName of config.repos) {
    const [owner, repo] = repoFullName.split('/');

    const prCursorKey = `${repoFullName}:prs`;
    const prSince = (await getCursor(store, 'github', prCursorKey)) ?? backfillSince;
    let latestPrTs = prSince;

    for await (const page of fetchPRs(client, owner, repo, prSince)) {
      for (const pr of page) {
        const item = normalizeGitHubPR(pr, repoFullName, config.topicAllowlist);
        if (item) {
          collected.push(item);
          if (pr.updated_at > latestPrTs) latestPrTs = pr.updated_at;
        }

        const reviews = await fetchPRReviews(client, owner, repo, pr.number);
        for (const review of reviews) {
          const reviewItem = normalizeGitHubReview(review, repoFullName, pr.number, config.topicAllowlist);
          if (reviewItem) collected.push(reviewItem);
        }
      }
    }

    if (latestPrTs !== prSince) {
      await setCursor(store, 'github', prCursorKey, latestPrTs);
    }

    const commentCursorKey = `${repoFullName}:comments`;
    const commentSince = (await getCursor(store, 'github', commentCursorKey)) ?? backfillSince;
    let latestCommentTs = commentSince;

    for await (const page of fetchPRComments(client, owner, repo, commentSince)) {
      for (const comment of page) {
        const item = normalizeGitHubComment(comment, repoFullName, config.topicAllowlist);
        if (item) {
          collected.push(item);
          if (comment.created_at > latestCommentTs) latestCommentTs = comment.created_at;
        }
      }
    }

    if (latestCommentTs !== commentSince) {
      await setCursor(store, 'github', commentCursorKey, latestCommentTs);
    }
  }

  return collected;
}

async function collectClickUp(store: GraphStore): Promise<NormalizedMessage[]> {
  const config = getClickUpConfig();
  const client = getClickUpClient(config.token);
  const { workspaceId, workspaceName } = await verifyClickUpAuth(client);

  const backfillSince = new Date(Date.now() - config.backfillDays * 86400 * 1000).toISOString();
  const collected: NormalizedMessage[] = [];

  for (const listId of config.listIds) {
    const listInfo = await getListInfo(client, listId);
    const taskCursorKey = `${listId}:tasks`;
    const taskSince = (await getCursor(store, 'clickup', taskCursorKey)) ?? backfillSince;
    let latestTaskTs = taskSince;
    let activitySupported = true;

    for await (const page of fetchTasks(client, listId, taskSince)) {
      for (const task of page) {
        const item = normalizeClickUpTask(task, listId, listInfo.name, config.topicAllowlist);
        if (item) {
          collected.push(item);
          if (task.date_updated > latestTaskTs) latestTaskTs = task.date_updated;
        }

        const taskSourceId = `clickup:${listId}:task:${task.id}`;
        const comments = await fetchComments(client, task.id);
        for (const comment of comments) {
          const commentItem = normalizeClickUpComment(comment, listId, listInfo.name, config.topicAllowlist, taskSourceId);
          if (commentItem) collected.push(commentItem);
        }

        if (activitySupported) {
          const activities = await fetchTaskActivity(client, task.id);
          if (activities === null) {
            activitySupported = false;
          } else {
            for (const activity of activities) {
              const statusItem = normalizeClickUpStatusChange(activity, task, listId, listInfo.name);
              if (statusItem) collected.push(statusItem);
            }
          }
        }
      }
    }

    if (latestTaskTs !== taskSince) {
      await setCursor(store, 'clickup', taskCursorKey, latestTaskTs);
    }
  }

  // Docs
  try {
    const docCursorKey = `${workspaceId}:docs`;
    const docSince = (await getCursor(store, 'clickup', docCursorKey)) ?? backfillSince;
    let latestDocTs = docSince;

    for await (const page of fetchDocs(client, workspaceId)) {
      for (const doc of page) {
        const docTs = new Date(Number(doc.date_updated)).toISOString();
        if (docTs <= docSince) continue;

        const item = normalizeClickUpDoc(doc, workspaceId, workspaceName, config.topicAllowlist);
        if (item) {
          collected.push(item);
          if (docTs > latestDocTs) latestDocTs = docTs;
        }
      }
    }

    if (latestDocTs !== docSince) {
      await setCursor(store, 'clickup', docCursorKey, latestDocTs);
    }
  } catch (err) {
    logger.warn({ err }, 'ClickUp Docs API unavailable — skipping docs collection');
  }

  return collected;
}

async function collectAppleCalendar(store: GraphStore): Promise<NormalizedMessage[]> {
  const config = getAppleCalendarConfig();
  const backfillSince = new Date(Date.now() - config.backfillDays * 86400 * 1000).toISOString();

  const cursorKey = `${config.username}:calendars`;
  const since = (await getCursor(store, 'apple-calendar', cursorKey)) ?? backfillSince;

  const events = await fetchCalendarEvents(config.username, config.password, since, config.calendarFilter);

  const collected: NormalizedMessage[] = [];
  for (const event of events) {
    const item = normalizeCalendarEvent(event, config.username, config.topicAllowlist);
    if (item) collected.push(item);
  }

  await setCursor(store, 'apple-calendar', cursorKey, new Date().toISOString());
  return collected;
}

async function collectClaudeCode(store: GraphStore): Promise<NormalizedMessage[]> {
  const config = getClaudeCodeConfig();

  if (!existsSync(config.projectsPath)) {
    logger.info({ path: config.projectsPath }, 'Claude Code projects path not found — skipping');
    return [];
  }

  const backfillSince = new Date(Date.now() - config.backfillDays * 86400 * 1000).toISOString();
  const projectDirs = discoverProjects(config.projectsPath);
  const collected: NormalizedMessage[] = [];

  for (const projectDirName of projectDirs) {
    const projectPath = `${config.projectsPath}/${projectDirName}`;
    const cursorKey = projectDirName;
    const cursor = await getCursor(store, 'claude-code', cursorKey);
    const since = cursor ?? backfillSince;
    const sinceDate = new Date(since);

    const sessionFiles = listSessionFiles(projectPath);
    let latestTs = since;

    for (const { path: filePath, mtime } of sessionFiles) {
      if (mtime <= sinceDate) continue;

      const session = parseSessionFile(filePath, projectDirName);
      if (!session) continue;
      if (session.lastTimestamp <= since) continue;

      let result;
      if (config.anthropicApiKey) {
        try {
          result = await summarizeSession(session, config.anthropicApiKey);
        } catch (err) {
          logger.warn({ sessionId: session.sessionId, err }, 'LLM summarization failed, using fallback');
          result = fallbackSummary(session);
        }
      } else {
        result = fallbackSummary(session);
      }

      collected.push(normalizeSession(session, result, config.userName, config.topicAllowlist));
      if (session.lastTimestamp > latestTs) latestTs = session.lastTimestamp;
    }

    if (latestTs !== since) {
      await setCursor(store, 'claude-code', cursorKey, latestTs);
    }
  }

  return collected;
}

async function collectTwitter(store: GraphStore): Promise<NormalizedMessage[]> {
  const config = getTwitterConfig();
  const client = getTwitterClient(config.cookies);
  await verifyTwitterAuth(client, config.usernames[0]);

  const backfillSince = new Date(
    Date.now() - config.backfillDays * 86400 * 1000,
  );
  const collected: NormalizedMessage[] = [];

  for (const username of config.usernames) {
    try {
      const cursorKey = `${username}:timeline`;
      const cursorVal = await getCursor(store, 'twitter', cursorKey);
      const since = cursorVal ? new Date(cursorVal) : backfillSince;
      let latestTs = cursorVal ?? backfillSince.toISOString();

      for await (const page of fetchUserTweets(client, username, since)) {
        for (const tweet of page) {
          const result = normalizeTweet(tweet, username, 'user_timeline', config.topicAllowlist);
          if (result) {
            collected.push(result);
            if (tweet.created_at > latestTs) latestTs = tweet.created_at;
          }
        }
      }

      if (latestTs !== (cursorVal ?? backfillSince.toISOString())) {
        await setCursor(store, 'twitter', cursorKey, latestTs);
      }
    } catch (err) {
      logger.warn({ username, err }, 'Failed to collect Twitter user — skipping');
    }
  }

  for (const query of config.searchQueries) {
    const safeKey = query.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const cursorKey = `search:${safeKey}`;
    const cursorVal = await getCursor(store, 'twitter', cursorKey);
    const since = cursorVal ? new Date(cursorVal) : backfillSince;
    let latestTs = cursorVal ?? backfillSince.toISOString();

    for await (const page of fetchSearchResults(client, query, since)) {
      for (const tweet of page) {
        const result = normalizeTweet(tweet, safeKey, 'search', config.topicAllowlist);
        if (result) {
          collected.push(result);
          if (tweet.created_at > latestTs) latestTs = tweet.created_at;
        }
      }
    }

    if (latestTs !== (cursorVal ?? backfillSince.toISOString())) {
      await setCursor(store, 'twitter', cursorKey, latestTs);
    }
  }

  return collected;
}

/** Ingest from all sources and return normalized messages (no upsert). */
export async function collectIngestion(store: GraphStore): Promise<NormalizedMessage[]> {
  const sources: Array<{ name: string; fn: () => Promise<NormalizedMessage[]> }> = [];

  if (process.env.SLACK_BOT_TOKEN) {
    sources.push({ name: 'Slack', fn: () => collectSlack(store) });
  }
  if (process.env.GITHUB_TOKEN) {
    sources.push({ name: 'GitHub', fn: () => collectGitHub(store) });
  }
  if (process.env.CLICKUP_TOKEN) {
    sources.push({ name: 'ClickUp', fn: () => collectClickUp(store) });
  }
  if (process.env.APPLE_CALDAV_USERNAME) {
    sources.push({ name: 'Apple Calendar', fn: () => collectAppleCalendar(store) });
  }
  if (process.env.TWITTER_COOKIES) {
    sources.push({ name: 'Twitter', fn: () => collectTwitter(store) });
  }

  const ccProjectsPath = process.env.CLAUDE_CODE_PROJECTS_PATH
    ?? `${process.env.HOME}/.claude/projects`;
  if (existsSync(ccProjectsPath) && process.env.ANTHROPIC_API_KEY) {
    sources.push({ name: 'Claude Code', fn: () => collectClaudeCode(store) });
  } else if (existsSync(ccProjectsPath)) {
    logger.info('Skipping Claude Code ingestion — ANTHROPIC_API_KEY not set (summaries would be low quality)');
  }

  const results = await Promise.allSettled(sources.map(s => s.fn()));
  const all: NormalizedMessage[] = [];

  for (let i = 0; i < sources.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      all.push(...result.value);
      logger.info({ source: sources[i].name, count: result.value.length }, 'Collected from source');
    } else {
      logger.error({ source: sources[i].name, err: result.reason }, 'Source collection failed');
    }
  }

  return all;
}

async function writeStatusFile(store: GraphStore, status: 'success' | 'error') {
  const [people, topics, containers, activities, cursorNodes] = await Promise.all([
    store.findNodes('Person', {}, { limit: 100000 }),
    store.findNodes('Topic', {}, { limit: 100000 }),
    store.findNodes('Container', {}, { limit: 100000 }),
    store.findNodes('Activity', {}, { limit: 100000 }),
    store.findNodes('Cursor', {}, { limit: 100 }),
  ]);

  const cursors = cursorNodes.map((n) => ({
    source: (n.properties.source as string) ?? '',
    container_id: (n.properties.container_id as string) ?? '',
    ts: (n.properties.latest_ts as string) ?? '',
  })).sort((a, b) => b.ts.localeCompare(a.ts));

  const payload = {
    lastRun: new Date().toISOString(),
    lastStatus: status,
    counts: {
      people: people.length,
      topics: topics.length,
      containers: containers.length,
      activities: activities.length,
    },
    cursors,
  };

  const filePath = resolve(process.cwd(), 'data/status.json');
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload, null, 2));
  logger.info({ path: filePath }, 'Wrote status.json');
}

/**
 * Post-ingestion researcher extraction: find all researcher instances,
 * open their graph stores, and run LLM extraction on recently ingested activities.
 */
async function runResearcherExtraction(ingestedActivities: NormalizedMessage[]): Promise<void> {
  if (ingestedActivities.length === 0) {
    logger.info('No activities to extract — skipping researcher extraction');
    return;
  }

  let researcherInstances: Array<{ name: string; path: string; domain: string }> = [];
  try {
    const entries = await findInstancesByType('researcher');
    researcherInstances = entries
      .filter(e => e.status === 'active')
      .map(e => {
        const config = readInstanceConfig(e.path);
        return { name: e.name, path: e.path, domain: config.domain ?? 'general' };
      });
  } catch {
    logger.info('No researcher instances found — skipping extraction');
    return;
  }

  if (researcherInstances.length === 0) {
    logger.info('No active researcher instances — skipping extraction');
    return;
  }

  for (const instance of researcherInstances) {
    const dbPath = resolve(instance.path, 'data', 'kuzu');
    let researcherStore: ResearcherGraphStore | undefined;

    try {
      researcherStore = new ResearcherGraphStore({ dbPath, readOnly: false });
      await researcherStore.initialize();

      logger.info(
        { instance: instance.name, domain: instance.domain, activities: ingestedActivities.length },
        'Running researcher extraction',
      );

      const counts = await extractAndUpsertResearcherData(
        ingestedActivities,
        instance.domain,
        researcherStore,
      );

      console.log(
        `Researcher "${instance.name}" (${instance.domain}): extracted ${counts.entitiesCount} entities, ${counts.eventsCount} events, ${counts.trendsCount} trends`,
      );
    } catch (err) {
      logger.error({ err, instance: instance.name }, 'Researcher extraction failed');
      console.error(`Researcher "${instance.name}": extraction FAILED — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (researcherStore) {
        try { await researcherStore.close(); } catch { /* ignore */ }
      }
    }
  }
}

async function main() {
  // Ingestion always targets global and needs write access
  process.env.GRAPHSTORE_READONLY = 'false';
  const store = await getGlobalGraphStore();
  await store.initialize();

  // Check for child instances to determine if orchestrator should route data
  let children: import('../orchestrator/types.js').InstanceContext[] = [];
  try {
    const { listInstances } = await import('../instance/registry.js');
    const { readInstanceConfig } = await import('../instance/resolve.js');
    const registryEntries = await listInstances({ status: 'active' });
    children = registryEntries
      .filter(e => e.name !== 'global')
      .map(e => {
        let description = e.description;
        let recentActivities;
        try {
          const config = readInstanceConfig(e.path);
          description = config.description ?? description;
          recentActivities = config.recentActivities;
        } catch { /* ignore */ }
        return { name: e.name, type: e.type, description, path: e.path, recentActivities };
      });
  } catch {
    // No global instance or registry — no children
  }

  // Build source lists
  type SourceDef = {
    name: string;
    ingestFn: () => Promise<void>;
    collectFn: () => Promise<NormalizedMessage[]>;
  };
  const sources: SourceDef[] = [];

  if (process.env.SLACK_BOT_TOKEN) {
    sources.push({ name: 'Slack', ingestFn: () => ingestSlack(store), collectFn: () => collectSlack(store) });
  } else {
    logger.info('SLACK_BOT_TOKEN not set — skipping Slack ingestion');
  }

  if (process.env.GITHUB_TOKEN) {
    sources.push({ name: 'GitHub', ingestFn: () => ingestGitHub(store), collectFn: () => collectGitHub(store) });
  } else {
    logger.info('GITHUB_TOKEN not set — skipping GitHub ingestion');
  }

  if (process.env.TWITTER_COOKIES) {
    sources.push({ name: 'Twitter', ingestFn: () => ingestTwitter(store), collectFn: () => collectTwitter(store) });
  } else {
    logger.info('TWITTER_COOKIES not set — skipping Twitter ingestion');
  }

  if (process.env.CLICKUP_TOKEN) {
    sources.push({ name: 'ClickUp', ingestFn: () => ingestClickUp(store), collectFn: () => collectClickUp(store) });
  } else {
    logger.info('CLICKUP_TOKEN not set — skipping ClickUp ingestion');
  }

  if (process.env.APPLE_CALDAV_USERNAME) {
    sources.push({ name: 'Apple Calendar', ingestFn: () => ingestAppleCalendar(store), collectFn: () => collectAppleCalendar(store) });
  } else {
    logger.info('APPLE_CALDAV_USERNAME not set — skipping Apple Calendar ingestion');
  }

  const ccProjectsPath = process.env.CLAUDE_CODE_PROJECTS_PATH
    ?? `${process.env.HOME}/.claude/projects`;
  if (existsSync(ccProjectsPath)) {
    sources.push({ name: 'Claude Code', ingestFn: () => ingestClaudeCode(store), collectFn: () => collectClaudeCode(store) });
  } else {
    logger.info('Claude Code projects path not found — skipping');
  }

  // Track all ingested activities for post-ingestion researcher extraction
  const allIngestedActivities: NormalizedMessage[] = [];

  if (children.length > 0) {
    // Orchestrated mode: collect from each source, then route via Claude CLI
    const { orchestrateSource } = await import('../orchestrator/index.js');
    logger.info({ childCount: children.length }, 'Child instances found — using orchestrated routing');

    for (const source of sources) {
      try {
        const messages = await source.collectFn();
        if (messages.length > 0) {
          allIngestedActivities.push(...messages);
          const result = await orchestrateSource(source.name, messages, children);
          console.log(`${source.name}: ${result.routedToChildren} to children, ${result.routedToGlobal} to global, ${result.fallbackToGlobal} fallback`);
          if (result.errors.length > 0) {
            console.error(`  Errors: ${result.errors.join('; ')}`);
          }
        } else {
          console.log(`${source.name}: no new data`);
        }
      } catch (err) {
        logger.error({ source: source.name, err }, 'Source collection/orchestration failed');
        console.error(`${source.name}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    // Direct mode: collect then ingest to global (no children to route to)
    // Collect first so we have activities available for researcher extraction
    const collectResults = await Promise.allSettled(sources.map((s) => s.collectFn()));

    for (let i = 0; i < sources.length; i++) {
      const result = collectResults[i];
      if (result.status === 'fulfilled' && result.value.length > 0) {
        allIngestedActivities.push(...result.value);
        // Upsert collected messages to global store
        for (let j = 0; j < result.value.length; j += UPSERT_BATCH_SIZE) {
          await upsertBatch(store, result.value.slice(j, j + UPSERT_BATCH_SIZE));
        }
        console.log(`${sources[i].name}: ingested ${result.value.length} items`);
      } else if (result.status === 'rejected') {
        logger.error({ source: sources[i].name, err: result.reason }, 'Source ingestion failed');
        console.error(`${sources[i].name}: FAILED — ${result.reason?.message ?? result.reason}`);
      }
    }
  }

  // Post-ingestion: link Person nodes that represent the same real person
  try {
    await linkPersons(store);
  } catch (err) {
    logger.warn({ err }, 'Person linking failed — skipping');
  }

  // Post-ingestion: run LLM extraction for researcher instances
  try {
    await runResearcherExtraction(allIngestedActivities);
  } catch (err) {
    logger.warn({ err }, 'Researcher extraction failed — skipping');
  }

  await writeStatusFile(store, 'success');
  await closeGraphStore();
  console.log('Ingestion complete');
}

// Only run main() when executed directly (not imported)
const isDirectRun = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isDirectRun) {
  main()
    .then(() => {
      // Force clean exit before Kuzu native cleanup can segfault
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error(err, 'Ingestion failed');
      console.error('Ingestion failed:', err.message);
      try {
        const store = await getGraphStore();
        await writeStatusFile(store, 'error');
      } catch { /* best effort */ }
      await closeGraphStore();
      process.exit(1);
    });
}

export { main };
