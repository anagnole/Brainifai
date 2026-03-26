import type { FastifyPluginAsync } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const STATUS_FILE = resolve(process.cwd(), 'data', 'status.json');

export const ingestRoute: FastifyPluginAsync = async (app) => {
  app.post('/ingest/run', async (_req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const child = spawn('npx', ['tsx', '--env-file=.env', 'src/ingestion/index.ts'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    const sendEvent = (type: string, data: string) => {
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify({ message: data })}\n\n`);
    };

    const handleData = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) {
          sendEvent(stream, line);
        }
      }
    };

    child.stdout.on('data', handleData('stdout'));
    child.stderr.on('data', handleData('stderr'));

    child.on('close', (code) => {
      sendEvent('done', `Process exited with code ${code}`);
      reply.raw.write('event: done\ndata: {}\n\n');
      reply.raw.end();
    });

    child.on('error', (err) => {
      sendEvent('error', err.message);
      reply.raw.write('event: done\ndata: {}\n\n');
      reply.raw.end();
    });

    // If the client disconnects, kill the child process
    _req.raw.on('close', () => {
      if (!child.killed) {
        child.kill();
      }
    });
  });

  app.get('/ingest/status', async () => {
    if (!existsSync(STATUS_FILE)) {
      return { lastRun: null };
    }

    try {
      const raw = readFileSync(STATUS_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { lastRun: null, error: 'Failed to read status file' };
    }
  });
};
