import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { GraphStore } from '../graphstore/types.js';
import { logger } from '../shared/logger.js';

interface PersonLink {
  canonical: string;
  aliases: string[];  // e.g. ["slack:U12345", "clickup:abc123"]
}

const LINKS_PATH = resolve(process.env.HOME ?? '~', '.brainifai/person-links.json');

/**
 * Load manual person links from ~/.brainifai/person-links.json.
 * File format: Array<{ canonical: string, aliases: string[] }>
 */
function loadManualLinks(): PersonLink[] {
  if (!existsSync(LINKS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LINKS_PATH, 'utf-8'));
  } catch (err) {
    logger.warn({ err, path: LINKS_PATH }, 'Failed to parse person-links.json');
    return [];
  }
}

/**
 * Extract username from a person_key like "local:foo" or "github:foo".
 * Returns the part after the first colon.
 */
function extractUsername(personKey: string): string | null {
  const colonIdx = personKey.indexOf(':');
  if (colonIdx < 0) return null;
  return personKey.slice(colonIdx + 1);
}

/**
 * Post-ingestion step: link Person nodes that represent the same real person.
 *
 * Strategy:
 * 1. Auto-link by username match: local:foo + github:foo → person:foo
 * 2. Manual mapping file for cross-source aliases
 * 3. Creates canonical Person node + IDENTIFIES edges from source accounts
 */
export async function linkPersons(store: GraphStore): Promise<void> {
  // 1. Fetch all Person nodes
  const persons = await store.findNodes('Person', {}, { limit: 100000 });

  // 2. Group by extracted username (auto-linking)
  const byUsername = new Map<string, string[]>();
  for (const p of persons) {
    const key = p.properties.person_key as string;
    // Skip already-canonical person nodes
    if (key.startsWith('person:')) continue;
    const username = extractUsername(key);
    if (!username) continue;
    const existing = byUsername.get(username) ?? [];
    existing.push(key);
    byUsername.set(username, existing);
  }

  // 3. Load manual links
  const manualLinks = loadManualLinks();

  let linkedCount = 0;

  // 4. For each group with 2+ members, create canonical Person + IDENTIFIES edges
  for (const [username, keys] of byUsername) {
    if (keys.length < 2) continue;

    const canonicalKey = `person:${username}`;

    // Find the best display name (prefer non-ID-like names)
    const bestPerson = persons.find(
      (p) => keys.includes(p.properties.person_key as string) &&
             p.properties.display_name !== p.properties.person_key
    ) ?? persons.find((p) => keys.includes(p.properties.person_key as string));

    const displayName = (bestPerson?.properties.display_name as string) ?? username;
    const now = new Date().toISOString();

    // Upsert canonical Person node
    await store.upsertNodes('Person', [{
      person_key: canonicalKey,
      display_name: displayName,
      source: 'linked',
      source_id: username,
      created_at: now,
      updated_at: now,
    }], ['person_key']);

    // Upsert IDENTIFIES edges from each source account to canonical person
    for (const sourceKey of keys) {
      const [source, ...rest] = sourceKey.split(':');
      const accountId = rest.join(':');

      await store.upsertEdges('IDENTIFIES', [{
        type: 'IDENTIFIES',
        fromLabel: 'SourceAccount',
        toLabel: 'Person',
        from: { source, account_id: accountId },
        to: { person_key: canonicalKey },
        properties: { first_seen: now },
      }]);
    }

    logger.info({ canonical: canonicalKey, sources: keys }, 'Linked person');
    linkedCount++;
  }

  // 5. Process manual links (for cross-username aliases)
  for (const link of manualLinks) {
    const canonicalKey = `person:${link.canonical}`;
    const now = new Date().toISOString();

    // Find best display name from aliases
    let displayName = link.canonical;
    for (const alias of link.aliases) {
      const person = persons.find((p) => p.properties.person_key === alias);
      if (person && person.properties.display_name !== alias) {
        displayName = person.properties.display_name as string;
        break;
      }
    }

    await store.upsertNodes('Person', [{
      person_key: canonicalKey,
      display_name: displayName,
      source: 'linked',
      source_id: link.canonical,
      created_at: now,
      updated_at: now,
    }], ['person_key']);

    for (const alias of link.aliases) {
      const [source, ...rest] = alias.split(':');
      const accountId = rest.join(':');

      await store.upsertEdges('IDENTIFIES', [{
        type: 'IDENTIFIES',
        fromLabel: 'SourceAccount',
        toLabel: 'Person',
        from: { source, account_id: accountId },
        to: { person_key: canonicalKey },
        properties: { first_seen: now },
      }]);
    }

    logger.info({ canonical: canonicalKey, aliases: link.aliases }, 'Linked person (manual)');
    linkedCount++;
  }

  if (linkedCount > 0) {
    console.log(`Person linking: created ${linkedCount} canonical person nodes`);
  }
}
