import { getGraphStore } from '../shared/graphstore.js';
import { extractKeywords } from './keywords.js';
import { getCached, setCache } from './cache.js';

const MAX_CONTEXT_CHARS = 500;
const HIGH_VALUE_KINDS = ['decision', 'insight', 'bug_fix'];

/** Time-ago label: "2h ago", "3d ago", etc. */
function ago(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export async function enrichToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string | null> {
  const { keywords, filePaths } = extractKeywords(toolName, toolInput);
  if (keywords.length === 0 && filePaths.length === 0) return null;

  const queryParts = [
    ...keywords,
    ...filePaths.map((p) => p.split('/').pop()).filter(Boolean),
  ];
  const query = queryParts.join(' ').trim();
  if (!query) return null;

  const cached = getCached(query);
  if (cached) return cached;

  const store = await getGraphStore();

  // Search for high-value activities (decisions, insights, bug fixes) matching
  // any extracted topic keyword. Try each keyword as a topic filter.
  const seen = new Set<string>();
  const items: Array<{ kind: string; snippet: string; timestamp: string }> = [];

  for (const kw of queryParts) {
    if (items.length >= 2) break;
    if (!kw) continue;
    const lower = kw.toLowerCase();

    // Skip the project name itself — not useful context
    const projectName = (process.env.CLAUDE_PROJECT_DIR ?? '').split('/').pop()?.toLowerCase();
    if (projectName && lower === projectName) continue;

    try {
      const activities = await store.getRecentActivity({
        topic: lower,
        kinds: HIGH_VALUE_KINDS,
        limit: 3,
      });

      for (const a of activities) {
        if (items.length >= 2) break;
        // Deduplicate by snippet prefix
        const key = a.snippet.slice(0, 40);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ kind: a.kind, snippet: a.snippet, timestamp: a.timestamp });
      }
    } catch { /* topic not found or query failed — skip */ }
  }

  if (items.length === 0) {
    // Negative-cache by storing an empty string; getCached treats '' same as a hit.
    setCache(query, '');
    return null;
  }

  const lines = items.map((a) => {
    const snip = a.snippet.length > 150 ? a.snippet.slice(0, 147) + '...' : a.snippet;
    return `- [${a.kind}] ${snip} (${ago(a.timestamp)})`;
  });

  const context = `[Brainifai KG]\n${lines.join('\n')}`;
  const trimmed = context.slice(0, MAX_CONTEXT_CHARS);

  setCache(query, trimmed);
  return trimmed;
}
