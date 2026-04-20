import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveInstance, readFolderConfigAt } from '../../instance/resolve.js';
import { writeFolderConfig, updateInstance } from '../../instance/folder-config.js';
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
      instance_name: z.string().optional()
        .describe('Required if the folder hosts multiple instances'),
    },
    async ({ description, auto_refine, instance_name }) => {
      let resolved;
      try {
        resolved = resolveInstance(undefined, instance_name);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true,
        };
      }

      const folderCfg = readFolderConfigAt(resolved.folderPath);
      if (!folderCfg) {
        return {
          content: [{ type: 'text' as const, text: `No FolderConfig at ${resolved.folderPath}` }],
          isError: true,
        };
      }

      const previousDescription = resolved.config.description;
      let newDescription: string;

      if (auto_refine) {
        const lastUpdated = new Date(resolved.config.updatedAt).getTime();
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
            instanceName: resolved.config.name,
            instanceType: resolved.config.type,
          });
        } catch (err) {
          logger.warn({ err, instance: resolved.config.name }, 'Auto-refinement failed');
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
            content: [{ type: 'text' as const, text: 'Either provide a description or set auto_refine=true.' }],
            isError: true,
          };
        }
        newDescription = description;
      }

      const updated = {
        ...resolved.config,
        description: newDescription,
        updatedAt: new Date().toISOString(),
      };
      writeFolderConfig(
        resolved.folderPath,
        updateInstance(folderCfg, resolved.config.name, updated),
      );

      logger.info({ instance: resolved.config.name, folderPath: resolved.folderPath }, 'Instance description updated');

      if (resolved.config.parent) {
        try {
          const { syncDescription } = await import('../../instance/registry.js');
          await syncDescription(resolved.config.name, newDescription);
        } catch (err) {
          logger.warn({ err }, 'Failed to sync description to global registry');
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: `Updated description for "${resolved.config.name}" instance.\nPrevious: ${previousDescription}\nNew: ${newDescription}${auto_refine ? '\n(auto-refined from graph data)' : ''}`,
        }],
      };
    },
  );
}
