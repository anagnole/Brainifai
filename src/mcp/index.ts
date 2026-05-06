// ─── Diagnostic instrumentation (FIRST THING IN THE FILE) ───────────────────
// Persistent post-mortem log at ~/.brainifai/logs/mcp-<pid>.log captures
// every signal, exit code, uncaught exception, and unhandled rejection so
// the next MCP "disappearance" leaves a record we can read.
// Pure observation — does NOT change MCP behavior, only logs it.

import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const MCP_LOG_DIR = resolve(homedir(), '.brainifai', 'logs');
const MCP_LOG_FILE = resolve(MCP_LOG_DIR, `mcp-${process.pid}.log`);
try { mkdirSync(MCP_LOG_DIR, { recursive: true }); } catch { /* ignore */ }

function fileLog(level: string, msg: string, data?: unknown): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    pid: process.pid,
    level,
    msg,
    ...(data !== undefined ? { data } : {}),
  }) + '\n';
  try { appendFileSync(MCP_LOG_FILE, line); } catch { /* never block */ }
}

fileLog('info', 'MCP process starting', { argv: process.argv, cwd: process.cwd(), node: process.version });

process.on('exit', (code) => fileLog('info', 'MCP process exit', { code }));
process.on('beforeExit', (code) => fileLog('info', 'MCP process beforeExit', { code }));

// CRITICAL: signal handlers must actually exit. Adding a handler at all
// suppresses Node's default exit-on-signal behavior; if we only log, the
// process becomes a zombie that keeps the Kuzu writer lock, port 4200, and
// stdio FDs held forever. That's exactly what was happening across reloads
// (multiple MCPs piling up, split-brain between port-holder and lock-holder).
// The shutdown is intentionally synchronous + immediate — releasing Kuzu
// cleanly via async cleanup risks Claude Code SIGKILL'ing us before we
// finish. Better to drop the lock by exiting fast and let the next MCP take
// it (Kuzu's stale-lock detection handles abrupt termination).
process.on('SIGTERM', () => {
  fileLog('warn', 'SIGTERM received — exiting');
  process.exit(0);
});
process.on('SIGINT', () => {
  fileLog('warn', 'SIGINT received — exiting');
  process.exit(0);
});
// Also exit when Claude Code closes our stdin (the JSON-RPC channel ending
// is the canonical "shutdown" signal for stdio MCP servers).
process.stdin.on('end', () => {
  fileLog('warn', 'stdin end — exiting');
  process.exit(0);
});
process.on('SIGHUP', () => fileLog('warn', 'SIGHUP received (ignored)'));
process.on('SIGPIPE', () => fileLog('warn', 'SIGPIPE received (ignored)'));
process.on('uncaughtException', (err) => {
  fileLog('fatal', 'uncaughtException', { message: err.message, stack: err.stack });
});

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { resolveMcpContext } from './instance-context.js';
import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';
import { logger } from '../shared/logger.js';
import { initEventBus, closeEventBus } from '../event-bus/index.js';
import { registerGlobalSubscriptions } from '../event-bus/global-subscriptions.js';
import { listInstances } from '../instance/registry.js';
import { setChildrenCache } from './children-cache.js';
import { createApiApp } from '../api/app.js';
import { setRole, installPromotionHook } from '../shared/role.js';
import type { FastifyInstance } from 'fastify';

// Catch native Kuzu errors that can escape as unhandled rejections (e.g. lock contention).
// Without this, Node.js v24+ crashes the process instead of allowing graceful recovery.
process.on('unhandledRejection', (err) => {
  fileLog('error', 'unhandledRejection', {
    err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
  });
  logger.warn({ err }, 'MCP server: unhandled rejection (non-fatal)');
});

async function main() {
  // Force on-demand mode so the MCP server doesn't hold a persistent Kuzu lock.
  process.env.GRAPHSTORE_ON_DEMAND = 'true';

  // Resolve instance context before anything else
  const ctx = resolveMcpContext();

  // Query the registry for children BEFORE opening the GraphStore.
  // This avoids Kuzu connection conflicts when ingest_memory needs the list later.
  try {
    const { readFolderConfigAt } = await import('../instance/resolve.js');
    const { findInstance } = await import('../instance/folder-config.js');
    const { dirname } = await import('node:path');
    const entries = await listInstances({ status: 'active' });
    const children = entries
      .filter((e) => e.parent !== null)   // exclude global-folder instances
      .map((e) => {
        // v2: entry.path = <folder>/.brainifai/<name>/ — FolderConfig is one level up.
        let description = e.description;
        let recentActivities;
        try {
          const folderCfg = readFolderConfigAt(dirname(e.path));
          const inst = folderCfg ? findInstance(folderCfg, e.name) : null;
          if (inst) {
            description = inst.description ?? description;
            recentActivities = inst.recentActivities;
          }
        } catch { /* ignore */ }
        return { name: e.name, type: e.type, description, path: e.path, recentActivities };
      });
    setChildrenCache(children);
    logger.info({ childCount: children.length }, 'Cached instance registry for orchestrator');
  } catch (err) {
    logger.warn({ err }, 'Could not query instance registry — ingest_memory will use direct write');
  }

  // Initialize GraphStore — use the resolved instance DB path explicitly
  const store = await getGraphStore(ctx?.dbPath);
  await store.initialize();

  // Initialize event bus and register global subscriptions
  const bus = await initEventBus();
  registerGlobalSubscriptions(bus, ctx?.instanceName);

  const server = await createServer(ctx);
  const transport = new StdioServerTransport();

  // Diagnostic: log if the stdio transport closes (would mean Claude Code
  // closed our stdin — i.e. voluntary disconnection on its side).
  transport.onclose = () => fileLog('warn', 'StdioServerTransport closed (Claude Code closed stdin)');
  // stdin EOF or error directly
  process.stdin.on('close', () => fileLog('warn', 'process.stdin close'));
  process.stdin.on('end', () => fileLog('warn', 'process.stdin end'));
  process.stdin.on('error', (err) => fileLog('error', 'process.stdin error', { message: err.message }));
  process.stdout.on('error', (err) => fileLog('error', 'process.stdout error (likely EPIPE)', { message: err.message }));

  await server.connect(transport);

  const instanceLabel = ctx ? `${ctx.instanceName} (${ctx.instanceType})` : 'global (default)';
  logger.info(`Brainifai MCP server started — instance: ${instanceLabel}`);
  fileLog('info', 'MCP transport connected', { instance: instanceLabel });

  // Embed the viz API in the MCP process so the dashboard can read the engine
  // DB while MCP holds the Kuzu lock. Also doubles as our leader-election
  // primitive: whoever wins port 4200 is the leader. Followers forward tool
  // calls via HTTP. See src/shared/role.ts for the protocol.
  installPromotionHook(attemptLeaderPromotion);
  await startEmbeddedVizApi();
}

let embeddedVizApp: FastifyInstance | null = null;

/**
 * Try to bind port 4200. Whoever wins is the leader (opens engine, runs the
 * worker, serves HTTP for itself + followers). Losing means another MCP is
 * already the leader on this machine — we become a follower and forward
 * tool calls via HTTP to localhost:4200.
 */
async function startEmbeddedVizApi(): Promise<void> {
  if (process.env.BRAINIFAI_DISABLE_EMBEDDED_VIZ === 'true') {
    // Standalone single-session mode. Act as leader (no follower forwarding).
    setRole('leader');
    logger.info('Embedded viz API disabled — running in solo leader mode');
    return;
  }
  const port = parseInt(process.env.VIZ_PORT ?? '4200', 10);
  try {
    embeddedVizApp = await createApiApp({ logger: false });
    await embeddedVizApp.listen({ port, host: '127.0.0.1' });
    setRole('leader');
    logger.info({ port }, 'Embedded viz API listening — leader mode');
  } catch (err) {
    embeddedVizApp = null;
    setRole('follower');
    logger.info(
      { err: (err as Error).message, port },
      'Port 4200 already taken — running as follower (tool calls will forward to leader)',
    );
  }
}

/**
 * Failover: when the active leader dies, followers' HTTP calls fail and they
 * try to promote. Promotion = "try to become the new leader" — bind 4200,
 * setRole('leader'), let the engine open lazily on the next tool call.
 *
 * Returns true if we won the leader role on this attempt (or already had it).
 */
async function attemptLeaderPromotion(): Promise<boolean> {
  if (embeddedVizApp) return true; // already serving, we're leader
  const port = parseInt(process.env.VIZ_PORT ?? '4200', 10);
  try {
    embeddedVizApp = await createApiApp({ logger: false });
    await embeddedVizApp.listen({ port, host: '127.0.0.1' });
    logger.info({ port }, 'Promoted to leader');
    return true;
  } catch {
    embeddedVizApp = null;
    return false;
  }
}

main().catch(async (err) => {
  logger.error(err, 'MCP server failed to start');
  if (embeddedVizApp) await embeddedVizApp.close().catch(() => { /* ignore */ });
  await closeEventBus();
  await closeGraphStore();
  process.exit(1);
});
