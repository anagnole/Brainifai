import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  ...(level !== 'silent' && {
    transport: {
      target: 'pino/file',
      options: { destination: 2 }, // stderr, keeps stdout clean for MCP
    },
  }),
});
