import { closeDriver } from '../shared/neo4j.js';
import { UPSERT_BATCH_SIZE } from '../shared/constants.js';
import { logger } from '../shared/logger.js';
import { seedSchema } from '../shared/schema.js';
import { getSlackConfig } from './slack/config.js';
import { getSlackClient, verifyAuth, fetchChannelInfo, fetchChannelHistory } from './slack/client.js';
import { normalizeSlackMessage } from './normalize.js';
import { getCursor, setCursor } from './cursor.js';
import { upsertBatch } from './upsert.js';
import type { NormalizedMessage } from '../shared/types.js';
import { getGitHubConfig } from './github/config.js';
import { getGitHubClient, verifyAuth as verifyGitHubAuth, fetchPRs, fetchPRComments, fetchPRReviews } from './github/client.js';
import { normalizeGitHubPR, normalizeGitHubComment, normalizeGitHubReview } from './github/normalize.js';
import { getClickUpConfig } from './clickup/config.js';
import { getClickUpClient, verifyAuth as verifyClickUpAuth, getListInfo, fetchTasks, fetchComments, fetchTaskActivity, fetchDocs } from './clickup/client.js';
import { normalizeClickUpTask, normalizeClickUpComment, normalizeClickUpStatusChange, normalizeClickUpDoc } from './clickup/normalize.js';
import { getAppleCalendarConfig } from './apple-calendar/config.js';
import { fetchCalendarEvents } from './apple-calendar/client.js';
import { normalizeCalendarEvent } from './apple-calendar/normalize.js';

async function ingestSlack() {
  const config = getSlackConfig();
  const slack = getSlackClient(config.token);

  await verifyAuth(slack);

  for (const channelId of config.channelIds) {
    const channelInfo = await fetchChannelInfo(slack, channelId);
    logger.info({ channel: channelInfo.name, id: channelId }, 'Processing channel');

    const cursor = await getCursor('slack', channelId);
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
        await upsertBatch(normalized.slice(i, i + UPSERT_BATCH_SIZE));
      }

      totalIngested += normalized.length;
    }

    if (latestTs !== oldest) {
      await setCursor('slack', channelId, latestTs);
    }

    console.log(`Slack #${channelInfo.name}: ingested ${totalIngested} messages`);
  }
}

async function ingestGitHub() {
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
    const prSince = (await getCursor('github', prCursorKey)) ?? backfillSince;
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
        await upsertBatch(normalized.slice(i, i + UPSERT_BATCH_SIZE));
      }

      prCount += page.length;
    }

    if (latestPrTs !== prSince) {
      await setCursor('github', prCursorKey, latestPrTs);
    }

    // --- PR Comments ---
    const commentCursorKey = `${repoFullName}:comments`;
    const commentSince = (await getCursor('github', commentCursorKey)) ?? backfillSince;
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
        await upsertBatch(normalized.slice(i, i + UPSERT_BATCH_SIZE));
      }

      commentCount += page.length;
    }

    if (latestCommentTs !== commentSince) {
      await setCursor('github', commentCursorKey, latestCommentTs);
    }

    console.log(`GitHub ${repoFullName}: ingested ${prCount} PRs, ${commentCount} comments`);
  }
}

async function ingestClickUp() {
  const config = getClickUpConfig();
  const client = getClickUpClient(config.token);

  const { workspaceId } = await verifyClickUpAuth(client);

  const backfillSince = new Date(
    Date.now() - config.backfillDays * 86400 * 1000,
  ).toISOString();

  // --- Tasks & Comments (per list) ---
  for (const listId of config.listIds) {
    const listInfo = await getListInfo(client, listId);
    logger.info({ list: listInfo.name, id: listId }, 'Processing ClickUp list');

    const taskCursorKey = `${listId}:tasks`;
    const taskSince = (await getCursor('clickup', taskCursorKey)) ?? backfillSince;
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
        const comments = await fetchComments(client, task.id);
        for (const comment of comments) {
          const commentItem = normalizeClickUpComment(comment, listId, listInfo.name, config.topicAllowlist);
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
        await upsertBatch(normalized.slice(i, i + UPSERT_BATCH_SIZE));
      }

      taskCount += page.length;
    }

    if (latestTaskTs !== taskSince) {
      await setCursor('clickup', taskCursorKey, latestTaskTs);
    }

    console.log(`ClickUp ${listInfo.name}: ingested ${taskCount} tasks, ${commentCount} comments`);
  }

  // --- Docs (per workspace) ---
  try {
    const docCursorKey = `${workspaceId}:docs`;
    const docSince = (await getCursor('clickup', docCursorKey)) ?? backfillSince;
    let docCount = 0;
    let latestDocTs = docSince;

    for await (const page of fetchDocs(client, workspaceId)) {
      const normalized: NormalizedMessage[] = [];

      for (const doc of page) {
        const docTs = new Date(Number(doc.date_updated)).toISOString();
        if (docTs <= docSince) continue;

        const item = normalizeClickUpDoc(doc, workspaceId, config.topicAllowlist);
        if (item) {
          normalized.push(item);
          if (docTs > latestDocTs) latestDocTs = docTs;
          docCount++;
        }
      }

      for (let i = 0; i < normalized.length; i += UPSERT_BATCH_SIZE) {
        await upsertBatch(normalized.slice(i, i + UPSERT_BATCH_SIZE));
      }
    }

    if (latestDocTs !== docSince) {
      await setCursor('clickup', docCursorKey, latestDocTs);
    }

    console.log(`ClickUp workspace: ingested ${docCount} docs`);
  } catch (err) {
    logger.warn({ err }, 'ClickUp Docs API unavailable — skipping docs ingestion');
    console.log('ClickUp workspace: docs skipped (API not available on this plan)');
  }
}

async function ingestAppleCalendar() {
  const config = getAppleCalendarConfig();
  const backfillSince = new Date(
    Date.now() - config.backfillDays * 86400 * 1000,
  ).toISOString();

  const cursorKey = `${config.username}:calendars`;
  const since = (await getCursor('apple-calendar', cursorKey)) ?? backfillSince;

  const events = await fetchCalendarEvents(config.username, config.password, since, config.calendarFilter);

  const normalized: NormalizedMessage[] = [];
  for (const event of events) {
    const item = normalizeCalendarEvent(event, config.username, config.topicAllowlist);
    if (item) normalized.push(item);
  }

  for (let i = 0; i < normalized.length; i += UPSERT_BATCH_SIZE) {
    await upsertBatch(normalized.slice(i, i + UPSERT_BATCH_SIZE));
  }

  await setCursor('apple-calendar', cursorKey, new Date().toISOString());
  console.log(`Apple Calendar: ingested ${normalized.length} events`);
}

async function main() {
  await seedSchema();

  // Slack ingestion (skip if not configured)
  if (process.env.SLACK_BOT_TOKEN) {
    await ingestSlack();
  } else {
    logger.info('SLACK_BOT_TOKEN not set — skipping Slack ingestion');
  }

  // GitHub ingestion (skip if not configured)
  if (process.env.GITHUB_TOKEN) {
    await ingestGitHub();
  } else {
    logger.info('GITHUB_TOKEN not set — skipping GitHub ingestion');
  }

  // ClickUp ingestion (skip if not configured)
  if (process.env.CLICKUP_TOKEN) {
    await ingestClickUp();
  } else {
    logger.info('CLICKUP_TOKEN not set — skipping ClickUp ingestion');
  }

  // Apple Calendar ingestion (skip if not configured)
  if (process.env.APPLE_CALDAV_USERNAME) {
    await ingestAppleCalendar();
  } else {
    logger.info('APPLE_CALDAV_USERNAME not set — skipping Apple Calendar ingestion');
  }

  await closeDriver();
  console.log('Ingestion complete');
}

main().catch(async (err) => {
  logger.error(err, 'Ingestion failed');
  console.error('Ingestion failed:', err.message);
  await closeDriver();
  process.exit(1);
});
