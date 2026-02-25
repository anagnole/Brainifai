import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { buildContextPacket } from '../../mcp/queries/context-packet.js';

export const contextRouter = Router();

const contextSchema = z.object({
  query: z.string().min(1),
  window_days: z.number().int().min(1).max(365).default(30),
  limit: z.number().int().min(1).max(50).default(20),
});

contextRouter.post('/', async (req: Request, res: Response) => {
  const parsed = contextSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { query, window_days, limit } = parsed.data;
  const packet = await buildContextPacket(query, window_days, limit);
  res.json({ data: packet });
});
