import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getRecentActivity } from '../../mcp/queries/activity.js';

export const activityRouter = Router();

const activitySchema = z.object({
  person: z.string().optional(),
  topic: z.string().optional(),
  container: z.string().optional(),
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

activityRouter.get('/', async (req: Request, res: Response) => {
  const parsed = activitySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0].message });
    return;
  }

  const { person, topic, container, days, limit } = parsed.data;
  const items = await getRecentActivity({
    personKey: person,
    topic,
    containerId: container,
    windowDays: days,
    limit,
  });

  res.json({ data: items });
});
