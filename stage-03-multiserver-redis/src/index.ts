import { WebSocketServer } from 'ws';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { migrate } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { closeRedis } from './db/redis.js';
import { createHttpServer } from './http/server.js';
import { attachWebSocketServer } from './ws/hub.js';
import { startRouting, stopRouting } from './ws/routing.js';

/**
 * Composition root for one gateway instance. Run several with different
 * SERVER_ID / PORT (see npm run start:a and start:b) to form a cluster. They
 * coordinate purely through Redis + Postgres, so they share no memory.
 */
async function main(): Promise<void> {
  await migrate();
  await startRouting();

  const httpServer = createHttpServer();
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  attachWebSocketServer(wss);

  await new Promise<void>((resolve) => httpServer.listen(config.PORT, config.HOST, resolve));
  logger.info({ port: config.PORT, server: config.SERVER_ID }, 'gateway listening (http + ws on /ws)');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    for (const client of wss.clients) client.close(1001, 'server shutting down');
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await stopRouting();
    await closeRedis();
    await closePool();
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
