import { WebSocketServer } from 'ws';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { migrate } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { createHttpServer } from './http/server.js';
import { attachWebSocketServer } from './ws/hub.js';

/**
 * Composition root. Wires HTTP + WebSocket on one port, runs migrations at
 * boot, and shuts down gracefully so in-flight work finishes and connections
 * close cleanly. Graceful shutdown matters even at Stage 00: it is the
 * difference between a clean deploy and dropping every user abruptly.
 */
async function main(): Promise<void> {
  await migrate();

  const httpServer = createHttpServer();
  // Share the HTTP server with the WS server so both live on one port and the
  // upgrade handshake is handled for us.
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  attachWebSocketServer(wss);

  await new Promise<void>((resolve) => {
    httpServer.listen(config.PORT, config.HOST, resolve);
  });
  logger.info({ port: config.PORT, host: config.HOST }, 'server listening (http + ws on /ws)');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Stop accepting new connections, then close existing sockets.
    for (const client of wss.clients) client.close(1001, 'server shutting down');
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closePool();
    logger.info('shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaughtException');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
