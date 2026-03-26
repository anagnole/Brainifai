/**
 * Claude session ingestor — scans ~/.claude/projects/ JSONL files
 * and matches sessions to projects by path prefix.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export interface IngestedSession {
  session_id: string;
  project_slug: string;
  project_path: string;
  date: string;
  summary: string;
  files_touched_count: number;
  model: string;
  duration_minutes: number;
}

const CLAUDE_PROJECTS_DIR = resolve(homedir(), '.claude', 'projects');

/**
 * Claude encodes project paths as directory names under ~/.claude/projects/
 * using the path with slashes replaced by hyphens (e.g. /Users/foo/Projects/bar → -Users-foo-Projects-bar)
 */
function decodeClaudioPath(dirName: string): string {
  // Directory names like "-Users-jane-Projects-MyApp"
  // Replace leading dash then remaining dashes that look like path separators
  return dirName.replace(/-/g, '/');
}

function matchProjectPath(claudeDir: string, projectPaths: string[]): string | null {
  const decoded = decodeClaudioPath(claudeDir);
  for (const p of projectPaths) {
    if (decoded === p || decoded.startsWith(p) || p.startsWith(decoded)) {
      return p;
    }
  }
  return null;
}

interface JsonlEntry {
  type?: string;
  message?: { role?: string; content?: string | Array<{ type: string; text?: string }> };
  timestamp?: string;
  model?: string;
  sessionId?: string;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: { type?: string; text?: string }) => c.type === 'text' && c.text)
      .map((c: { type?: string; text?: string }) => c.text ?? '')
      .join(' ');
  }
  return '';
}

function parseJsonlSession(filePath: string): {
  model: string;
  messages: Array<{ role: string; text: string; timestamp: string }>;
  sessionId: string;
} {
  const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  const messages: Array<{ role: string; text: string; timestamp: string }> = [];
  let model = '';
  let sessionId = createHash('md5').update(filePath).digest('hex').slice(0, 16);

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as JsonlEntry;
      if (entry.model && !model) model = entry.model;
      if (entry.sessionId) sessionId = entry.sessionId;
      if (entry.type === 'message' || entry.message) {
        const msg = entry.message ?? entry;
        const role = (msg as JsonlEntry['message'])?.role ?? 'unknown';
        const content = (msg as JsonlEntry['message'])?.content;
        const text = extractTextFromContent(content);
        const timestamp = entry.timestamp ?? '';
        if (text) messages.push({ role, text, timestamp });
      }
    } catch { /* skip malformed lines */ }
  }

  return { model, messages, sessionId };
}

function summarizeSession(messages: Array<{ role: string; text: string }>): string {
  // Take first user message as summary (truncated)
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '';
  return first.text.slice(0, 200).replace(/\n/g, ' ');
}

function countFilesTouched(messages: Array<{ role: string; text: string }>): number {
  // Count unique file paths mentioned in tool use / assistant messages
  const filePaths = new Set<string>();
  for (const msg of messages) {
    const matches = msg.text.matchAll(/(?:\/[^\s"'<>]+\.[a-z]{1,5})/g);
    for (const m of matches) filePaths.add(m[0]);
  }
  return filePaths.size;
}

function estimateDurationMinutes(messages: Array<{ role: string; text: string; timestamp: string }>): number {
  const timestamps = messages
    .map((m) => m.timestamp)
    .filter(Boolean)
    .map((t) => new Date(t).getTime())
    .filter((t) => !isNaN(t))
    .sort((a, b) => a - b);

  if (timestamps.length < 2) return 0;
  return Math.round((timestamps[timestamps.length - 1] - timestamps[0]) / 60000);
}

/** Scan ~/.claude/projects/ and match sessions to known project paths. */
export function ingestClaudeSessions(
  projectsByPath: Map<string, string>, // path → slug
): IngestedSession[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const results: IngestedSession[] = [];
  let claudeDirs: string[];
  try { claudeDirs = readdirSync(CLAUDE_PROJECTS_DIR); } catch { return []; }

  const projectPaths = Array.from(projectsByPath.keys());

  for (const claudeDir of claudeDirs) {
    const fullDir = join(CLAUDE_PROJECTS_DIR, claudeDir);
    let stat;
    try { stat = statSync(fullDir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const matchedPath = matchProjectPath(claudeDir, projectPaths);
    if (!matchedPath) continue;
    const projectSlug = projectsByPath.get(matchedPath) ?? '';

    // Read all JSONL files in this project directory
    let files: string[];
    try { files = readdirSync(fullDir); } catch { continue; }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(fullDir, file);

      try {
        const { model, messages, sessionId } = parseJsonlSession(filePath);
        if (messages.length === 0) continue;

        const timestamps = messages.map((m) => m.timestamp).filter(Boolean);
        const date = timestamps.length > 0
          ? new Date(Math.min(...timestamps.map((t) => new Date(t).getTime())))
            .toISOString().split('T')[0]
          : file.replace('.jsonl', '').slice(0, 10);

        results.push({
          session_id: sessionId,
          project_slug: projectSlug,
          project_path: matchedPath,
          date,
          summary: summarizeSession(messages),
          files_touched_count: countFilesTouched(messages),
          model: model || 'unknown',
          duration_minutes: estimateDurationMinutes(messages),
        });
      } catch { /* skip unparseable files */ }
    }
  }

  return results;
}
