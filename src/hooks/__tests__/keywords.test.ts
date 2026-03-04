import { describe, it, expect } from 'vitest';
import { extractKeywords } from '../keywords.js';

describe('extractKeywords', () => {
  describe('Grep', () => {
    it('extracts pattern as keyword', () => {
      const result = extractKeywords('Grep', { pattern: 'searchEntities' });
      expect(result.keywords).toEqual(['searchEntities']);
    });

    it('extracts path as filePath', () => {
      const result = extractKeywords('Grep', {
        pattern: 'foo',
        path: 'src/mcp/queries',
      });
      expect(result.keywords).toEqual(['foo']);
      expect(result.filePaths).toEqual(['src/mcp/queries']);
    });
  });

  describe('Glob', () => {
    it('extracts meaningful segments from glob pattern', () => {
      const result = extractKeywords('Glob', { pattern: '**/*.auth.ts' });
      expect(result.keywords).toContain('auth');
    });

    it('filters out short segments', () => {
      const result = extractKeywords('Glob', { pattern: '**/a.ts' });
      // "a" and "ts" are <=2 chars, should be filtered
      expect(result.keywords).toEqual([]);
    });
  });

  describe('Read/Edit/Write', () => {
    it('extracts file path and meaningful segments', () => {
      const result = extractKeywords('Read', {
        file_path: '/Users/dev/Projects/Brainifai/src/hooks/enricher.ts',
      });
      expect(result.filePaths).toEqual([
        '/Users/dev/Projects/Brainifai/src/hooks/enricher.ts',
      ]);
      expect(result.keywords).toContain('hooks');
      expect(result.keywords).toContain('enricher.ts');
    });

    it('filters out common directory names', () => {
      const result = extractKeywords('Edit', {
        file_path: '/src/lib/index.ts',
      });
      // "src", "lib", "index" are filtered; only "index.ts" remains from last-3 slice
      expect(result.keywords).not.toContain('src');
      expect(result.keywords).not.toContain('lib');
      expect(result.keywords).not.toContain('index');
    });
  });

  describe('Bash', () => {
    it('skips trivial commands', () => {
      const result = extractKeywords('Bash', { command: 'ls -la' });
      expect(result.keywords).toEqual([]);
      expect(result.filePaths).toEqual([]);
    });

    it('extracts keywords from git commit message', () => {
      const result = extractKeywords('Bash', {
        command: "git commit -m 'fix authentication flow'",
      });
      expect(result.keywords).toContain('authentication');
      expect(result.keywords).toContain('flow');
      // "fix" is <=3 chars, filtered
      expect(result.keywords).not.toContain('fix');
    });

    it('extracts paths from git diff', () => {
      const result = extractKeywords('Bash', {
        command: 'git diff src/hooks/enricher.ts',
      });
      expect(result.keywords).toContain('hooks');
      expect(result.keywords).toContain('enricher.ts');
    });

    it('returns empty for unknown tool names', () => {
      const result = extractKeywords('Agent', { prompt: 'do something' });
      expect(result.keywords).toEqual([]);
      expect(result.filePaths).toEqual([]);
    });
  });
});
