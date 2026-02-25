import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { searchEntities } from '../../mcp/queries/search.js';
import { getEntitySummary } from '../../mcp/queries/summary.js';

export const entitiesRouter = Router();

const searchSchema = z.object({
  q: z.string().min(1),
  types: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

entitiesRouter.get('/search', async (req: Request, res: Response) => {
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { q, types, limit } = parsed.data;
  const typeList = types
    ? types.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined;

  const results = await searchEntities(q, typeList, limit);
  res.json({ data: results });
});

// GET /api/entities/summary?id=github:anagnole%2FBrainifai
entitiesRouter.get('/summary', async (req: Request, res: Response) => {
  const entityId = req.query['id'];
  if (!entityId || typeof entityId !== 'string') {
    res.status(400).json({ error: '`id` query param is required' });
    return;
  }

  const summary = await getEntitySummary(entityId);
  if (!summary) {
    res.status(404).json({ error: `entity not found: ${entityId}` });
    return;
  }

  res.json({ data: summary });
});
