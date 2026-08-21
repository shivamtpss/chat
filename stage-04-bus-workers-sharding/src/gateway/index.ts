import { WebSocketServer } from 'ws';
import { config } from '../lib/config.js';
import { makeLogger } from '../lib/logger.js';
import { migrate } from '../db/migrate.js';
import { closePool } from '../db/pool.js';
import { closeRedis } from '../db/redis.js';
import { ensureGroup } from '../bus/bus.js';
import { startGatewaySubscriber, refreshPresence, clearPresence } from '../bus/routing.js';
import { createHttpServer } from './http.js';
import { attachConnectionHandlers, deliverLocal, localUserIds } from './hub.js';

const logger = makeLogger(`gateway:${config.SERVER_ID}`);

/**
 * A gateway instance: holds WebSocket connections, accepts sends and drops them
 * on the durable bus, and pushes anything published to its own channel (both
 * new messages for recipients and the durable ack back to the original sender).
 */
async function main(): Promise<void> {
  await migrate();
  await ensureGroup();

  // Receive deliveries/acks routed to this gateway and push them to sockets.
  await startGatewaySubscriber(config.SERVER_ID, (userId, msg) => deliverLocal(userId, msg));

  const httpServer = createHttpServer();
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  attachConnectionHandlers(wss);

  await new Promise<void>((resolve) => httpServer.listen(config.PORT, config.HOST, resolve));
  logger.info({ port: config.PORT }, 'gateway listening (http + ws on /ws)');

  // Presence heartbeat: refresh the directory entries for our connected users.
  const hb = setInterval(() => {
    void refreshPresence(localUserIds(), config.SERVER_ID);
  }, config.PRESENCE_HEARTBEAT_MS);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(hb);
    for (const client of wss.clients) client.close(1001, 'server shutting down');
    for (const userId of localUserIds()) await clearPresence(userId, config.SERVER_ID);
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await closeRedis();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
