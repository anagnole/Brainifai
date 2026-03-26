/**
 * Dependency ingestor — parses manifests to extract project dependencies.
 * Supports: package.json, requirements.txt, pyproject.toml, pubspec.yaml, Package.swift
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ParsedDependency {
  dep_key: string;     // "ecosystem:name"
  ecosystem: string;
  name: string;
  version: string;     // version string from manifest (may be a range)
  is_dev: boolean;
  lock_version: string;
  latest_version: string;
  is_outdated: boolean;
}

// ─── package.json (npm/yarn/pnpm) ─────────────────────────────────────────────

function parsePackageJson(dir: string): ParsedDependency[] {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return [];

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch { return []; }

  const deps: ParsedDependency[] = [];
  const prod = (pkg.dependencies ?? {}) as Record<string, string>;
  const dev = (pkg.devDependencies ?? {}) as Record<string, string>;

  for (const [name, version] of Object.entries(prod)) {
    deps.push(makeDep('npm', name, version, false));
  }
  for (const [name, version] of Object.entries(dev)) {
    deps.push(makeDep('npm', name, version, true));
  }
  return deps;
}

// ─── requirements.txt ─────────────────────────────────────────────────────────

function parseRequirementsTxt(dir: string): ParsedDependency[] {
  const reqPath = join(dir, 'requirements.txt');
  if (!existsSync(reqPath)) return [];

  const deps: ParsedDependency[] = [];
  try {
    const lines = readFileSync(reqPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      // e.g. "requests==2.31.0" or "flask>=2.0"
      const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*([=><~!].+)?$/);
      if (match) {
        deps.push(makeDep('pip', match[1], match[2]?.trim() ?? '', false));
      }
    }
  } catch { /* ignore */ }
  return deps;
}

// ─── pyproject.toml ───────────────────────────────────────────────────────────

function parsePyprojectToml(dir: string): ParsedDependency[] {
  const tomlPath = join(dir, 'pyproject.toml');
  if (!existsSync(tomlPath)) return [];

  const deps: ParsedDependency[] = [];
  try {
    const content = readFileSync(tomlPath, 'utf-8');
    // Simple regex extraction — avoids a full TOML parser dependency
    // Matches lines like: "requests = \"^2.28\""
    const depSection = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\[|$)/);
    if (depSection) {
      for (const line of depSection[1].split('\n')) {
        const match = line.match(/^([a-zA-Z0-9_.-]+)\s*=\s*["']?([^"'\n]+)["']?/);
        if (match && match[1] !== 'python') {
          deps.push(makeDep('pip', match[1], match[2].trim(), false));
        }
      }
    }
    // Also check [project] dependencies array
    const projDeps = content.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
    if (projDeps) {
      for (const line of projDeps[1].split('\n')) {
        const match = line.match(/"([A-Za-z0-9_.-]+)([=><~!].+)?"/);
        if (match) deps.push(makeDep('pip', match[1], match[2]?.trim() ?? '', false));
      }
    }
  } catch { /* ignore */ }
  return deps;
}

// ─── pubspec.yaml (Flutter/Dart) ──────────────────────────────────────────────

function parsePubspecYaml(dir: string): ParsedDependency[] {
  const pubPath = join(dir, 'pubspec.yaml');
  if (!existsSync(pubPath)) return [];

  const deps: ParsedDependency[] = [];
  try {
    const content = readFileSync(pubPath, 'utf-8');
    let inDeps = false;
    let isDevDeps = false;

    for (const line of content.split('\n')) {
      if (line.match(/^dependencies:/)) { inDeps = true; isDevDeps = false; continue; }
      if (line.match(/^dev_dependencies:/)) { inDeps = true; isDevDeps = true; continue; }
      if (line.match(/^[a-z]/) && !line.match(/^  /)) { inDeps = false; continue; }

      if (inDeps) {
        const match = line.match(/^\s{2}([a-zA-Z0-9_]+):\s*(.+)?/);
        if (match && match[1] !== 'flutter' && match[1] !== 'sdk') {
          deps.push(makeDep('pub', match[1], match[2]?.trim() ?? '', isDevDeps));
        }
      }
    }
  } catch { /* ignore */ }
  return deps;
}

// ─── Package.swift ────────────────────────────────────────────────────────────

function parsePackageSwift(dir: string): ParsedDependency[] {
  const swiftPath = join(dir, 'Package.swift');
  if (!existsSync(swiftPath)) return [];

  const deps: ParsedDependency[] = [];
  try {
    const content = readFileSync(swiftPath, 'utf-8');
    // Match .package(url: "...", from: "1.0.0") or similar
    const packageMatches = content.matchAll(/\.package\s*\(url:\s*"([^"]+)"[^)]*\)/g);
    for (const m of packageMatches) {
      const url = m[1];
      // Extract package name from URL (last path component without .git)
      const name = url.split('/').pop()?.replace(/\.git$/, '') ?? url;
      const versionMatch = m[0].match(/(?:from:|exact:|upToNextMajor|upToNextMinor)[^"]*"([^"]+)"/);
      deps.push(makeDep('spm', name, versionMatch?.[1] ?? '', false));
    }
  } catch { /* ignore */ }
  return deps;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDep(ecosystem: string, name: string, version: string, isDev: boolean): ParsedDependency {
  return {
    dep_key: `${ecosystem}:${name}`,
    ecosystem,
    name,
    version,
    is_dev: isDev,
    lock_version: '',       // populated separately if lock file parsed
    latest_version: '',     // populated by registry check (future)
    is_outdated: false,     // populated by registry check (future)
  };
}

/** Parse all known manifests in a project directory. */
export function parseDependencies(dir: string): ParsedDependency[] {
  const all: ParsedDependency[] = [
    ...parsePackageJson(dir),
    ...parseRequirementsTxt(dir),
    ...parsePyprojectToml(dir),
    ...parsePubspecYaml(dir),
    ...parsePackageSwift(dir),
  ];

  // Deduplicate by dep_key (first occurrence wins)
  const seen = new Set<string>();
  return all.filter((d) => {
    if (seen.has(d.dep_key)) return false;
    seen.add(d.dep_key);
    return true;
  });
}
