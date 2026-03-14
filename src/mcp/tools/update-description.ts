import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findProjectInstance, readInstanceConfig, writeInstanceConfig, globalInstanceExists, GLOBAL_BRAINIFAI_PATH } from '../../instance/resolve.js';
import { logger } from '../../shared/logger.js';

export function registerUpdateDescription(server: McpServer) {
  server.tool(
    'update_instance_description',
    'Update the description of the current Brainifai instance based on accumulated knowledge from this session',
    {
      description: z.string().min(1).max(2000)
        .describe('The refined instance description — should capture what this instance/project is about'),
    },
    async ({ description }) => {
      // Find the nearest instance (project first, then global)
      const projectPath = findProjectInstance();
      const instancePath = projectPath ?? (globalInstanceExists() ? GLOBAL_BRAINIFAI_PATH : null);

      if (!instancePath) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No Brainifai instance found. Run `brainifai init` first.',
          }],
          isError: true,
        };
      }

      const config = readInstanceConfig(instancePath);
      const previousDescription = config.description;
      config.description = description;
      config.updatedAt = new Date().toISOString();
      writeInstanceConfig(instancePath, config);

      logger.info({ instance: config.name, instancePath }, 'Instance description updated');

      // Sync to global registry if this is a child instance
      if (config.parent) {
        try {
          const { syncDescription } = await import('../../instance/registry.js');
          await syncDescription(config.name, description);
          logger.info({ instance: config.name }, 'Description synced to global registry');
        } catch (err) {
          logger.warn({ err, instance: config.name }, 'Failed to sync description to global registry');
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Updated description for "${config.name}" instance.\nPrevious: ${previousDescription}\nNew: ${description}`,
        }],
      };
    },
  );
}
