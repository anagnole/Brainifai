import { searchEntities } from '../mcp/queries/search.js';
import { extractKeywords } from './keywords.js';
import { getCached, setCache } from './cache.js';

const MAX_CONTEXT_CHARS = 500;

export async function enrichToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<string | null> {
  const { keywords, filePaths } = extractKeywords(toolName, toolInput);
  if (keywords.length === 0 && filePaths.length === 0) return null;

  const query = [
    ...keywords,
    ...filePaths.map((p) => p.split('/').pop()).filter(Boolean),
  ].join(' ');
  if (!query.trim()) return null;

  const cached = getCached(query);
  if (cached) return cached;

  const results = await searchEntities(query, undefined, 5);
  if (results.length === 0) return null;

  const lines = results
    .filter((r) => r.score > 0.3)
    .slice(0, 3)
    .map((r) => `- ${r.name} (${r.type}, relevance: ${r.score.toFixed(1)})`);
  if (lines.length === 0) return null;

  const context = `[Brainifai KG] Related entities:\n${lines.join('\n')}`;
  const trimmed = context.slice(0, MAX_CONTEXT_CHARS);

  setCache(query, trimmed);
  return trimmed;
}
