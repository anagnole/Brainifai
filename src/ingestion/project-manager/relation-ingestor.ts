/**
 * Relation ingestor — detects cross-project dependencies and infers RELATED_TO edges.
 *
 * Detection strategies:
 * 1. Local file:// or relative path references in package.json (explicit DEPENDS_ON)
 * 2. Shared packages used across 3+ projects (RELATED_TO with confidence "medium")
 * 3. Same git remote host organization (RELATED_TO with confidence "low")
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

export interface ProjectRelation {
  from_slug: string;
  to_slug: string;
  relation_type: 'DEPENDS_ON' | 'RELATED_TO';
  dependency_type?: string;
  description?: string;
  confidence?: string;
}

interface ProjectInfo {
  slug: string;
  path: string;
}

/** Extract local path references from package.json dependencies */
function detectLocalPackageRefs(project: ProjectInfo, allProjects: ProjectInfo[]): ProjectRelation[] {
  const pkgPath = join(project.path, 'package.json');
  if (!existsSync(pkgPath)) return [];

  let pkg: Record<string, unknown>;
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')); }
  catch { return []; }

  const relations: ProjectRelation[] = [];
  const allDeps = {
    ...(pkg.dependencies ?? {}) as Record<string, string>,
    ...(pkg.devDependencies ?? {}) as Record<string, string>,
  };

  for (const [, version] of Object.entries(allDeps)) {
    if (typeof version !== 'string') continue;
    // Detect file:// or relative path references
    if (version.startsWith('file:') || version.startsWith('../') || version.startsWith('./')) {
      const relPath = version.replace(/^file:/, '');
      const absPath = resolve(project.path, relPath);

      const target = allProjects.find((p) => p.path === absPath || absPath.startsWith(p.path));
      if (target && target.slug !== project.slug) {
        relations.push({
          from_slug: project.slug,
          to_slug: target.slug,
          relation_type: 'DEPENDS_ON',
          dependency_type: 'local-package',
          description: `${project.slug} references ${target.slug} via local path`,
        });
      }
    }
  }

  return relations;
}

/** Detect shared npm/pip packages used by multiple projects (heuristic) */
function detectSharedPackages(allProjects: ProjectInfo[]): ProjectRelation[] {
  // Build: packageName → [projectSlug]
  const packageUsers = new Map<string, string[]>();

  for (const project of allProjects) {
    const pkgPath = join(project.path, 'package.json');
    if (!existsSync(pkgPath)) continue;

    let pkg: Record<string, unknown>;
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')); }
    catch { continue; }

    const deps = Object.keys({
      ...(pkg.dependencies ?? {}) as Record<string, string>,
    });

    // Only consider notable shared packages (SDKs, DB drivers, internal utils)
    const notable = deps.filter((d) =>
      d.startsWith('@') || // scoped packages often indicate shared org libraries
      d.includes('sdk') ||
      d.includes('client') ||
      d.includes('api'),
    );

    for (const dep of notable) {
      if (!packageUsers.has(dep)) packageUsers.set(dep, []);
      packageUsers.get(dep)!.push(project.slug);
    }
  }

  const relations: ProjectRelation[] = [];
  for (const [pkg, users] of packageUsers) {
    if (users.length < 2) continue;
    // Add RELATED_TO edges between all pairs that share this package
    for (let i = 0; i < users.length; i++) {
      for (let j = i + 1; j < users.length; j++) {
        relations.push({
          from_slug: users[i],
          to_slug: users[j],
          relation_type: 'RELATED_TO',
          description: `Both use ${pkg}`,
          confidence: users.length >= 3 ? 'high' : 'medium',
        });
      }
    }
  }
  return relations;
}

/** Detect projects in the same git remote organization */
function detectSameOrg(allProjects: ProjectInfo[]): ProjectRelation[] {
  const orgMap = new Map<string, string[]>(); // org → [slug]

  for (const project of allProjects) {
    try {
      const remoteOut = execSync('git remote get-url origin', {
        cwd: project.path,
        stdio: ['pipe', 'pipe', 'ignore'],
        timeout: 3000,
      }).toString().trim();

      // Extract org from https://github.com/org/repo or git@github.com:org/repo
      const match = remoteOut.match(/[:/]([^/]+)\/[^/]+(?:\.git)?$/);
      if (match) {
        const org = match[1];
        if (!orgMap.has(org)) orgMap.set(org, []);
        orgMap.get(org)!.push(project.slug);
      }
    } catch { /* no remote */ }
  }

  const relations: ProjectRelation[] = [];
  for (const [, slugs] of orgMap) {
    if (slugs.length < 2) continue;
    for (let i = 0; i < slugs.length; i++) {
      for (let j = i + 1; j < slugs.length; j++) {
        relations.push({
          from_slug: slugs[i],
          to_slug: slugs[j],
          relation_type: 'RELATED_TO',
          description: 'Same git remote organization',
          confidence: 'low',
        });
      }
    }
  }
  return relations;
}

/** Run all relation detection strategies and deduplicate. */
export function detectRelations(allProjects: ProjectInfo[]): ProjectRelation[] {
  const all: ProjectRelation[] = [];

  for (const project of allProjects) {
    all.push(...detectLocalPackageRefs(project, allProjects));
  }
  all.push(...detectSharedPackages(allProjects));
  all.push(...detectSameOrg(allProjects));

  // Deduplicate: same from+to+type
  const seen = new Set<string>();
  return all.filter((r) => {
    const key = `${r.from_slug}:${r.to_slug}:${r.relation_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
