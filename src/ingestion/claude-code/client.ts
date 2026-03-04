import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { resolve, basename } from 'path';
import { logger } from '../../shared/logger.js';
import type { SessionLine, ContentBlock, ParsedSession } from './types.js';

/** List project directories under ~/.claude/projects/ */
export function discoverProjects(projectsPath: string): string[] {
  if (!existsSync(projectsPath)) return [];

  return readdirSync(projectsPath, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name);
}

/** List .jsonl session files in a project dir, sorted by mtime descending. */
export function listSessionFiles(projectPath: string): Array<{ path: string; mtime: Date }> {
  if (!existsSync(projectPath)) return [];

  return readdirSync(projectPath, { withFileTypes: true })
    .filter((f) => f.isFile() && f.name.endsWith('.jsonl'))
    .map((f) => {
      const fullPath = resolve(projectPath, f.name);
      const stat = statSync(fullPath);
      return { path: fullPath, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

/** Derive a human-readable project name from the dir slug. */
export function deriveProjectName(dirName: string): string {
  // "-Users-anagnole-Projects-Brainifai" → last segment
  const parts = dirName.split('-').filter(Boolean);
  return parts[parts.length - 1] || dirName;
}

/** Extract text from a content block array, skipping tool_use/tool_result/thinking. */
function extractText(content: string | ContentBlock[] | undefined): string | null {
  if (!content) return null;
  if (typeof content === 'string') return content;

  const texts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      texts.push(block.text);
    }
  }
  return texts.length > 0 ? texts.join('\n') : null;
}

/** Parse a single JSONL session file into a ParsedSession. */
export function parseSessionFile(filePath: string, projectDirName: string): ParsedSession | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.warn({ filePath, err }, 'Failed to read session file');
    return null;
  }

  const lines = raw.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  let sessionId = '';
  let slug = '';
  let cwd = '';
  let gitBranch = '';
  let firstTimestamp = '';
  let lastTimestamp = '';
  const userMessages: string[] = [];
  const assistantMessages: string[] = [];

  for (const line of lines) {
    let parsed: SessionLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip non-message lines (file-history-snapshot, etc.)
    if (!parsed.message) continue;

    // Extract metadata from first message line that has it
    if (parsed.sessionId && !sessionId) sessionId = parsed.sessionId;
    if (parsed.slug && !slug) slug = parsed.slug;
    if (parsed.cwd && !cwd) cwd = parsed.cwd;
    if (parsed.gitBranch && !gitBranch) gitBranch = parsed.gitBranch;

    if (parsed.timestamp) {
      if (!firstTimestamp) firstTimestamp = parsed.timestamp;
      lastTimestamp = parsed.timestamp;
    }

    const role = parsed.message.role;
    const text = extractText(parsed.message.content);
    if (!text) continue;

    if (role === 'user') {
      userMessages.push(text);
    } else if (role === 'assistant') {
      assistantMessages.push(text);
    }
  }

  if (userMessages.length === 0) return null;

  // Fallback sessionId from filename
  if (!sessionId) {
    sessionId = basename(filePath, '.jsonl');
  }

  return {
    sessionId,
    slug,
    projectDirName,
    projectName: deriveProjectName(projectDirName),
    cwd,
    gitBranch,
    firstTimestamp: firstTimestamp || new Date().toISOString(),
    lastTimestamp: lastTimestamp || new Date().toISOString(),
    userMessages,
    assistantMessages,
    filePath,
  };
}
