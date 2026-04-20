import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { resolveMcpContext } from './instance-context.js';
import { getGraphStore, closeGraphStore } from '../shared/graphstore.js';
import { logger } from '../shared/logger.js';
import { initEventBus, closeEventBus } from '../event-bus/index.js';
import { registerGlobalSubscriptions } from '../event-bus/global-subscriptions.js';
import { listInstances } from '../instance/registry.js';
import { setChildrenCache } from './children-cache.js';

// Catch native Kuzu errors that can escape as unhandled rejections (e.g. lock contention).
// Without this, Node.js v24+ crashes the process instead of allowing graceful recovery.
process.on('unhandledRejection', (err) => {
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
  await server.connect(transport);

  const instanceLabel = ctx ? `${ctx.instanceName} (${ctx.instanceType})` : 'global (default)';
  logger.info(`Brainifai MCP server started — instance: ${instanceLabel}`);
}

main().catch(async (err) => {
  logger.error(err, 'MCP server failed to start');
  await closeEventBus();
  await closeGraphStore();
  process.exit(1);
});
