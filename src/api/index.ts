import express from 'express';
import { entitiesRouter } from './routes/entities.js';
import { activityRouter } from './routes/activity.js';
import { contextRouter } from './routes/context.js';
import { closeDriver } from '../shared/neo4j.js';
import { logger } from '../shared/logger.js';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.use(express.json());

app.use('/api/entities', entitiesRouter);
app.use('/api/activity', activityRouter);
app.use('/api/context', contextRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error(err, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Brainifai API server started');
  console.log(`API running at http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'Shutting down API server');
    server.close();
    await closeDriver();
    process.exit(0);
  });
}
