export interface KeywordResult {
  keywords: string[];
  filePaths: string[];
}

export function extractKeywords(
  toolName: string,
  toolInput: Record<string, unknown>,
): KeywordResult {
  const keywords: string[] = [];
  const filePaths: string[] = [];

  switch (toolName) {
    case 'Grep':
      if (toolInput.pattern) keywords.push(String(toolInput.pattern));
      if (toolInput.path) filePaths.push(String(toolInput.path));
      break;

    case 'Glob':
      if (toolInput.pattern) {
        const parts = String(toolInput.pattern)
          .replace(/\*+/g, ' ')
          .split(/[/.\s]+/)
          .filter((p) => p.length > 2);
        keywords.push(...parts);
      }
      break;

    case 'Edit':
    case 'Write':
    case 'Read':
      if (toolInput.file_path) {
        filePaths.push(String(toolInput.file_path));
        const segs = String(toolInput.file_path)
          .split('/')
          .filter(
            (s) => s.length > 2 && !/^(src|lib|index|node_modules)$/.test(s),
          )
          .slice(-3);
        keywords.push(...segs);
      }
      break;

    case 'Bash':
      if (toolInput.command) {
        const cmd = String(toolInput.command);
        if (/^(cd|ls|pwd|echo|cat|head|tail|mkdir|chmod|which)\b/.test(cmd)) {
          return { keywords: [], filePaths: [] };
        }
        if (cmd.startsWith('git')) keywords.push(...extractGitKeywords(cmd));
      }
      break;
  }

  return { keywords, filePaths };
}

function extractGitKeywords(cmd: string): string[] {
  const msgMatch = cmd.match(/-m\s+['"]([^'"]+)['"]/);
  if (msgMatch) {
    return msgMatch[1].split(/\s+/).filter((w) => w.length > 3);
  }
  const pathMatch = cmd.match(/(?:diff|log|show|blame)\s+(.+)/);
  if (pathMatch) {
    return pathMatch[1]
      .split(/[\s/]+/)
      .filter((w) => w.length > 2 && !w.startsWith('-'));
  }
  return [];
}
