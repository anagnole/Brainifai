import { logger } from '../../shared/logger.js';
import { stripAnsi } from '../../shared/sanitize.js';
import type { ParsedSession, SummarizeResult } from './types.js';

const MAX_TRANSCRIPT_CHARS = 12000;
const SUMMARIZE_MODEL = 'claude-haiku-4-5-20251001';

/** Build a transcript string from user/assistant messages, capped at MAX_TRANSCRIPT_CHARS. */
function buildTranscript(session: ParsedSession): string {
  const parts: string[] = [];
  const maxPerSide = Math.min(session.userMessages.length, session.assistantMessages.length);

  // Interleave user/assistant messages
  for (let i = 0; i < maxPerSide; i++) {
    parts.push(`User: ${stripAnsi(session.userMessages[i])}`);
    parts.push(`Assistant: ${stripAnsi(session.assistantMessages[i])}`);
  }
  // Remaining messages from whichever side has more
  for (let i = maxPerSide; i < session.userMessages.length; i++) {
    parts.push(`User: ${stripAnsi(session.userMessages[i])}`);
  }
  for (let i = maxPerSide; i < session.assistantMessages.length; i++) {
    parts.push(`Assistant: ${stripAnsi(session.assistantMessages[i])}`);
  }

  const full = parts.join('\n\n');
  if (full.length <= MAX_TRANSCRIPT_CHARS) return full;
  return full.slice(0, MAX_TRANSCRIPT_CHARS) + '\n\n[...truncated]';
}

/** Summarize a session using the Anthropic Messages API. */
export async function summarizeSession(
  session: ParsedSession,
  apiKey: string,
): Promise<SummarizeResult> {
  const transcript = buildTranscript(session);

  const body = {
    model: SUMMARIZE_MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user' as const,
      content: `You are summarizing a Claude Code coding session for a personal knowledge graph.

Project: ${session.projectName}
Branch: ${session.gitBranch || 'unknown'}
Directory: ${session.cwd || 'unknown'}

Transcript:
${transcript}

Write a 2-3 paragraph summary of what was accomplished in this session. Focus on:
- What task(s) the user was working on
- Key decisions made
- Important code changes or bug fixes
- Any problems encountered and how they were resolved

End with a line: "Topics: topic1, topic2, topic3" listing 3-8 relevant lowercase topics (technologies, concepts, project areas).`,
    }],
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.warn({ status: response.status, body: text }, 'Summarization API failed');
    return fallbackSummary(session);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  const text = data.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');

  // Parse topics from the "Topics: ..." line
  const topicsMatch = text.match(/Topics?:\s*(.+)/i);
  const topics = topicsMatch
    ? topicsMatch[1].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];

  // Summary is everything before the Topics line
  const summary = text.replace(/Topics?:\s*.+/i, '').trim();

  return { summary: summary || text, topics };
}

/** Fallback when no API key: use metadata + first/last user messages. */
export function fallbackSummary(session: ParsedSession): SummarizeResult {
  const parts: string[] = [];

  parts.push(`Claude Code session in project "${session.projectName}".`);
  if (session.gitBranch) parts.push(`Branch: ${session.gitBranch}.`);
  parts.push(`${session.userMessages.length} user messages, ${session.assistantMessages.length} assistant messages.`);

  if (session.userMessages.length > 0) {
    const first = stripAnsi(session.userMessages[0]).slice(0, 500);
    parts.push(`\nFirst request: ${first}`);
  }

  if (session.userMessages.length > 1) {
    const last = stripAnsi(session.userMessages[session.userMessages.length - 1]).slice(0, 300);
    parts.push(`\nLast request: ${last}`);
  }

  const topics: string[] = [session.projectName.toLowerCase()];
  if (session.gitBranch) topics.push(session.gitBranch.toLowerCase());

  return { summary: parts.join(' '), topics };
}
