import { DEFAULT_BACKFILL_DAYS } from '../../shared/constants.js';

export function getGitHubConfig() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable is required');
  }

  const repos = (process.env.GITHUB_REPOS ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  if (repos.length === 0) {
    throw new Error('GITHUB_REPOS environment variable is required (comma-separated owner/repo)');
  }

  const backfillDays = parseInt(process.env.BACKFILL_DAYS ?? '', 10) || DEFAULT_BACKFILL_DAYS;

  const topicAllowlist = (process.env.TOPIC_ALLOWLIST ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  return { token, repos, backfillDays, topicAllowlist };
}
