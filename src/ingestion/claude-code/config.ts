import { homedir } from 'os';
import { resolve } from 'path';
import { DEFAULT_BACKFILL_DAYS } from '../../shared/constants.js';

export interface ClaudeCodeConfig {
  projectsPath: string;
  anthropicApiKey: string | undefined;
  userName: string;
  backfillDays: number;
  topicAllowlist: string[];
}

export function getClaudeCodeConfig(): ClaudeCodeConfig {
  const projectsPath = process.env.CLAUDE_CODE_PROJECTS_PATH
    ?? resolve(homedir(), '.claude/projects');

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || undefined;

  const userName = process.env.BRAINIFAI_USER_NAME
    ?? process.env.USER
    ?? 'unknown';

  const backfillDays = parseInt(process.env.BACKFILL_DAYS ?? '', 10)
    || DEFAULT_BACKFILL_DAYS;

  const topicAllowlist = (process.env.TOPIC_ALLOWLIST ?? '')
    .split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

  return { projectsPath, anthropicApiKey, userName, backfillDays, topicAllowlist };
}
