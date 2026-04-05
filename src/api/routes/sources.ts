import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

const ENV_PATH = resolve(process.cwd(), '.env');

/** Env var → source mapping */
const SOURCE_KEYS: Record<string, { token: string; list: string; listSep?: string }> = {
  slack: { token: 'SLACK_BOT_TOKEN', list: 'SLACK_CHANNEL_IDS' },
  github: { token: 'GITHUB_TOKEN', list: 'GITHUB_REPOS' },
  clickup: { token: 'CLICKUP_TOKEN', list: 'CLICKUP_LIST_IDS' },
};

const CALENDAR_KEYS = {
  username: 'APPLE_CALDAV_USERNAME',
  password: 'APPLE_CALDAV_PASSWORD',
  calendars: 'APPLE_CALDAV_CALENDARS',
};

const CLAUDE_CODE_KEY = 'CLAUDE_CODE_PROJECTS_PATH';
const DEFAULT_CLAUDE_PATH = '~/.claude/projects';

function readEnv(): Map<string, string> {
  if (!existsSync(ENV_PATH)) return new Map();
  const lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
  const map = new Map<string, string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return map;
}

function writeEnvKey(key: string, value: string) {
  if (!existsSync(ENV_PATH)) {
    writeFileSync(ENV_PATH, `${key}=${value}\n`);
    return;
  }
  const lines = readFileSync(ENV_PATH, 'utf-8').split('\n');
  let found = false;
  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) return line;
    const eq = trimmed.indexOf('=');
    if (eq < 0) return line;
    if (trimmed.slice(0, eq) === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) updated.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, updated.join('\n'));
}

function mask(val: string | undefined): string | null {
  if (!val) return null;
  if (val.length <= 4) return '****';
  return '****' + val.slice(-4);
}

function csvToArray(val: string | undefined): string[] {
  if (!val?.trim()) return [];
  return val.split(',').map((s) => s.trim()).filter(Boolean);
}

export async function sourcesRoute(app: FastifyInstance) {
  app.get('/sources', async () => {
    const env = readEnv();

    const result: Record<string, unknown> = {};

    // Standard sources (token + list)
    for (const [source, keys] of Object.entries(SOURCE_KEYS)) {
      const token = env.get(keys.token);
      const list = csvToArray(env.get(keys.list));
      result[source] = {
        configured: !!token && list.length > 0,
        tokenSet: !!token,
        tokenMasked: mask(token),
        items: list,
      };
    }

    // Apple Calendar
    const calUser = env.get(CALENDAR_KEYS.username);
    const calPass = env.get(CALENDAR_KEYS.password);
    result['apple-calendar'] = {
      configured: !!calUser && !!calPass,
      usernameSet: !!calUser,
      usernameMasked: mask(calUser),
      passwordSet: !!calPass,
      calendars: csvToArray(env.get(CALENDAR_KEYS.calendars)),
    };

    // Claude Code
    const ccPath = env.get(CLAUDE_CODE_KEY) || DEFAULT_CLAUDE_PATH;
    result['claude-code'] = {
      configured: true,
      projectsPath: ccPath,
    };

    // Global settings
    result['global'] = {
      backfillDays: parseInt(env.get('BACKFILL_DAYS') ?? '7', 10),
      topicAllowlist: csvToArray(env.get('TOPIC_ALLOWLIST')),
    };

    return result;
  });

  app.put<{ Params: { source: string }; Body: { items?: string[]; calendars?: string[] } }>(
    '/sources/:source',
    async (req, reply) => {
      const { source } = req.params;
      const body = req.body as Record<string, unknown>;

      if (SOURCE_KEYS[source]) {
        const items = body.items as string[] | undefined;
        if (!items || !Array.isArray(items)) {
          return reply.status(400).send({ error: 'items array required' });
        }
        writeEnvKey(SOURCE_KEYS[source].list, items.join(','));
        return { ok: true, source, items };
      }

      if (source === 'apple-calendar') {
        const calendars = body.calendars as string[] | undefined;
        if (!calendars || !Array.isArray(calendars)) {
          return reply.status(400).send({ error: 'calendars array required' });
        }
        writeEnvKey(CALENDAR_KEYS.calendars, calendars.join(','));
        return { ok: true, source, calendars };
      }

      return reply.status(404).send({ error: `Unknown source: ${source}` });
    },
  );

  app.put<{ Params: { source: string }; Body: { token?: string; username?: string; password?: string } }>(
    '/sources/:source/token',
    async (req, reply) => {
      const { source } = req.params;
      const body = req.body as Record<string, unknown>;

      if (SOURCE_KEYS[source]) {
        const token = body.token as string;
        if (!token) return reply.status(400).send({ error: 'token required' });
        writeEnvKey(SOURCE_KEYS[source].token, token);
        return { ok: true, masked: mask(token) };
      }

      if (source === 'apple-calendar') {
        if (body.username) writeEnvKey(CALENDAR_KEYS.username, body.username as string);
        if (body.password) writeEnvKey(CALENDAR_KEYS.password, body.password as string);
        return { ok: true, masked: mask(body.username as string ?? body.password as string) };
      }

      return reply.status(404).send({ error: `Unknown source: ${source}` });
    },
  );

  app.put<{ Body: { backfillDays?: number; topicAllowlist?: string[] } }>(
    '/sources/global',
    async (req) => {
      const body = req.body as Record<string, unknown>;
      if (body.backfillDays != null) {
        writeEnvKey('BACKFILL_DAYS', String(body.backfillDays));
      }
      if (body.topicAllowlist != null) {
        writeEnvKey('TOPIC_ALLOWLIST', (body.topicAllowlist as string[]).join(','));
      }
      return { ok: true };
    },
  );
}
