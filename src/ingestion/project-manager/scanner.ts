/**
 * Project scanner — walks ~/Projects, finds git repos, extracts metadata.
 *
 * Detects:
 * - Language: from dominant file extensions
 * - Framework: from config files (package.json, pyproject.toml, etc.)
 * - Description: from package.json or README first line
 * - Created/updated timestamps: from git log
 */

import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

export interface ScannedProject {
  slug: string;
  name: string;
  path: string;
  language: string;
  framework: string;
  description: string;
  created_at: string;
  updated_at: string;
}

const PROJECTS_DIR = resolve(homedir(), 'Projects');

const LANGUAGE_EXT_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.py': 'Python',
  '.swift': 'Swift',
  '.dart': 'Dart',
  '.rb': 'Ruby',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.c': 'C',
};

/** Walk a directory one level deep, counting file extensions. */
function countExtensions(dir: string, maxDepth = 2): Map<string, number> {
  const counts = new Map<string, number>();
  function walk(d: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules' || entry === '__pycache__' || entry === '.git') continue;
      const full = join(d, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else {
        const ext = extname(entry).toLowerCase();
        if (ext) counts.set(ext, (counts.get(ext) ?? 0) + 1);
      }
    }
  }
  walk(dir, 0);
  return counts;
}

function detectLanguage(dir: string): string {
  const counts = countExtensions(dir);
  let best = '';
  let bestCount = 0;
  for (const [ext, count] of counts) {
    const lang = LANGUAGE_EXT_MAP[ext];
    if (lang && count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best;
}

function detectFramework(dir: string): string {
  // Node/npm
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next']) return 'Next.js';
      if (deps['react']) return 'React';
      if (deps['vue']) return 'Vue';
      if (deps['@angular/core']) return 'Angular';
      if (deps['svelte']) return 'Svelte';
      if (deps['express']) return 'Express';
      if (deps['fastify']) return 'Fastify';
      if (deps['electron']) return 'Electron';
      if (deps['@tauri-apps/api']) return 'Tauri';
      if (pkg.name) return 'Node.js';
    } catch { /* ignore */ }
  }

  // Python
  if (existsSync(join(dir, 'pyproject.toml'))) {
    try {
      const content = readFileSync(join(dir, 'pyproject.toml'), 'utf-8');
      if (content.includes('fastapi')) return 'FastAPI';
      if (content.includes('django')) return 'Django';
      if (content.includes('flask')) return 'Flask';
    } catch { /* ignore */ }
    return 'Python';
  }
  if (existsSync(join(dir, 'requirements.txt'))) {
    try {
      const content = readFileSync(join(dir, 'requirements.txt'), 'utf-8');
      if (content.includes('fastapi')) return 'FastAPI';
      if (content.includes('django')) return 'Django';
      if (content.includes('flask')) return 'Flask';
    } catch { /* ignore */ }
    return 'Python';
  }

  // Flutter/Dart
  if (existsSync(join(dir, 'pubspec.yaml'))) return 'Flutter';

  // Swift
  if (existsSync(join(dir, 'Package.swift'))) return 'Swift Package Manager';
  if (existsSync(join(dir, 'project.pbxproj')) || readdirSync(dir).some(f => f.endsWith('.xcodeproj'))) {
    return 'Xcode';
  }

  // Ruby
  if (existsSync(join(dir, 'Gemfile'))) {
    try {
      const content = readFileSync(join(dir, 'Gemfile'), 'utf-8');
      if (content.includes('rails')) return 'Rails';
    } catch { /* ignore */ }
    return 'Ruby';
  }

  // Go
  if (existsSync(join(dir, 'go.mod'))) return 'Go';

  // Rust
  if (existsSync(join(dir, 'Cargo.toml'))) return 'Rust/Cargo';

  return '';
}

function extractDescription(dir: string): string {
  // Try package.json description
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.description && typeof pkg.description === 'string') return pkg.description;
    } catch { /* ignore */ }
  }

  // Try README first line
  for (const name of ['README.md', 'Readme.md', 'readme.md']) {
    const readmePath = join(dir, name);
    if (existsSync(readmePath)) {
      try {
        const lines = readFileSync(readmePath, 'utf-8').split('\n');
        const first = lines.find((l) => l.trim() && !l.startsWith('#'));
        if (first) return first.trim().slice(0, 200);
        // fallback: use the first heading
        const heading = lines.find((l) => l.startsWith('#'));
        if (heading) return heading.replace(/^#+\s*/, '').trim();
      } catch { /* ignore */ }
    }
  }

  return '';
}

function gitDate(dir: string, flag: '--diff-filter=A' | ''): string {
  try {
    if (flag === '--diff-filter=A') {
      // oldest commit date (creation approximation)
      const out = execSync('git log --follow --diff-filter=A --format=%aI -- . | tail -1', {
        cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000,
      }).toString().trim();
      if (out) return out.split('T')[0];
    } else {
      // most recent commit date
      const out = execSync('git log -1 --format=%aI', {
        cwd: dir, stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000,
      }).toString().trim();
      if (out) return out.split('T')[0];
    }
  } catch { /* ignore */ }
  return new Date().toISOString().split('T')[0];
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/** Scan ~/Projects and return all discovered git repositories. */
export function scanProjects(projectsDir = PROJECTS_DIR): ScannedProject[] {
  const results: ScannedProject[] = [];

  let entries: string[];
  try { entries = readdirSync(projectsDir); } catch { return results; }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const full = resolve(projectsDir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;

    if (isGitRepo(full)) {
      results.push(extractProjectMetadata(full));
    } else {
      // One level of nesting (e.g. ~/Projects/work/my-app)
      let subEntries: string[];
      try { subEntries = readdirSync(full); } catch { continue; }
      for (const sub of subEntries) {
        if (sub.startsWith('.')) continue;
        const subFull = resolve(full, sub);
        let subStat;
        try { subStat = statSync(subFull); } catch { continue; }
        if (subStat.isDirectory() && isGitRepo(subFull)) {
          results.push(extractProjectMetadata(subFull));
        }
      }
    }
  }

  return results;
}

function extractProjectMetadata(dir: string): ScannedProject {
  const slug = dir.split('/').pop() ?? dir;
  const language = detectLanguage(dir);
  const framework = detectFramework(dir);
  const description = extractDescription(dir);
  const updatedAt = gitDate(dir, '');
  const createdAt = gitDate(dir, '--diff-filter=A');

  // Extract name from package.json or git remote or directory name
  let name = slug;
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name) name = pkg.name;
    } catch { /* ignore */ }
  }

  return { slug, name, path: dir, language, framework, description, created_at: createdAt, updated_at: updatedAt };
}
