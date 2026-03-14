import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { findProjectInstance, readInstanceConfig, writeInstanceConfig, globalInstanceExists, GLOBAL_BRAINIFAI_PATH } from '../../instance/resolve.js';
import { logger } from '../../shared/logger.js';

export function registerUpdateDescription(server: McpServer) {
  server.tool(
    'update_instance_description',
    'Update the description of the current Brainifai instance based on accumulated knowledge from this session. Set auto_refine=true to let AI generate the description from graph data.',
    {
      description: z.string().min(1).max(2000).optional()
        .describe('The refined instance description — required unless auto_refine is true'),
      auto_refine: z.boolean().default(false)
        .describe('When true, uses AI to generate a description from the instance graph data'),
    },
    async ({ description, auto_refine }) => {
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

      let newDescription: string;

      if (auto_refine) {
        // Rate-limit: skip if refined less than 24 hours ago
        const lastUpdated = new Date(config.updatedAt).getTime();
        const hoursSinceUpdate = (Date.now() - lastUpdated) / (1000 * 60 * 60);
        if (hoursSinceUpdate < 24 && !description) {
          return {
            content: [{
              type: 'text' as const,
              text: `Description was updated ${Math.round(hoursSinceUpdate)}h ago. Skipping auto-refinement (24h cooldown). Current: "${previousDescription}"`,
            }],
          };
        }

        try {
          const { getGraphStore } = await import('../../shared/graphstore.js');
          const { gatherRefinementContext, generateRefinedDescription } = await import('../../context/refinement.js');

          const store = await getGraphStore();
          const context = await gatherRefinementContext(store);
          newDescription = await generateRefinedDescription({
            ...context,
            currentDescription: previousDescription,
            instanceName: config.name,
            instanceType: config.type,
          });
        } catch (err) {
          logger.warn({ err, instance: config.name }, 'Auto-refinement failed, keeping existing description');
          return {
            content: [{
              type: 'text' as const,
              text: `Auto-refinement failed: ${err instanceof Error ? err.message : String(err)}. Current description unchanged.`,
            }],
            isError: true,
          };
        }
      } else {
        if (!description) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Either provide a description or set auto_refine=true.',
            }],
            isError: true,
          };
        }
        newDescription = description;
      }

      config.description = newDescription;
      config.updatedAt = new Date().toISOString();
      writeInstanceConfig(instancePath, config);

      logger.info({ instance: config.name, instancePath }, 'Instance description updated');

      // Sync to global registry if this is a child instance
      if (config.parent) {
        try {
          const { syncDescription } = await import('../../instance/registry.js');
          await syncDescription(config.name, newDescription);
          logger.info({ instance: config.name }, 'Description synced to global registry');
        } catch (err) {
          logger.warn({ err, instance: config.name }, 'Failed to sync description to global registry');
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Updated description for "${config.name}" instance.\nPrevious: ${previousDescription}\nNew: ${newDescription}${auto_refine ? '\n(auto-refined from graph data)' : ''}`,
        }],
      };
    },
  );
}
