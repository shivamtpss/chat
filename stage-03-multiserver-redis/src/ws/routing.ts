import { redis, publisher, subscriber } from '../db/redis.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { local } from './registry.js';
import type { DeliveryEnvelope, ServerMessage } from './protocol.js';

/**
 * The Redis routing layer: the new brain of Stage 03.
 *
 * TWO jobs:
 *   1. DIRECTORY  - "which server is user X connected to?"
 *        We store a Redis set  presence:{userId} = { "A", "B", ... }
 *        (a user could be on more than one server via different devices).
 *        Each server refreshes its membership with a heartbeat; keys carry a
 *        TTL so a crashed server's entries disappear on their own.
 *   2. MAILBOX    - each server subscribes to its own channel  server:{id}.
 *        To deliver to a user, we look up their server(s) in the directory and
 *        PUBLISH the message to those servers' channels. The owning server
 *        receives it and pushes it down the local socket.
 */

const channelFor = (serverId: string): string => `server:${serverId}`;
const presenceKey = (userId: string): string => `presence:${userId}`;
const myChannel = channelFor(config.SERVER_ID);

let heartbeat: NodeJS.Timeout | null = null;
const onlineUsers = new Set<string>(); // users this server currently holds

/** Subscribe to this server's channel and deliver incoming envelopes locally. */
export async function startRouting(): Promise<void> {
  await subscriber.subscribe(myChannel);
  subscriber.on('message', (channel, raw) => {
    if (channel !== myChannel) return;
    let env: DeliveryEnvelope;
    try {
      env = JSON.parse(raw) as DeliveryEnvelope;
    } catch {
      logger.warn({ raw }, 'bad delivery envelope');
      return;
    }
    const outbound: ServerMessage = {
      type: 'message',
      message: env.message,
      viaServer: config.SERVER_ID,
    };
    const delivered = local.deliverLocal(env.targetUserId, outbound);
    if (!delivered) {
      // The user just disconnected between the directory lookup and now. Fine:
      // the message is already durable in Postgres and will be fetched on
      // reconnect via history. This is the "at-least-once + cursor" safety net.
      logger.debug({ targetUserId: env.targetUserId }, 'recipient not local anymore, skipped');
    }
  });

  // Refresh presence for all locally-connected users on a timer.
  heartbeat = setInterval(() => {
    void refreshPresence();
  }, config.PRESENCE_HEARTBEAT_MS);

  logger.info({ channel: myChannel }, 'routing started');
}

async function refreshPresence(): Promise<void> {
  if (onlineUsers.size === 0) return;
  const pipe = redis.pipeline();
  for (const userId of onlineUsers) {
    pipe.sadd(presenceKey(userId), config.SERVER_ID);
    pipe.expire(presenceKey(userId), config.PRESENCE_TTL_SECONDS);
  }
  await pipe.exec();
}

/** Called when a user connects to THIS server. */
export async function registerPresence(userId: string): Promise<void> {
  onlineUsers.add(userId);
  await redis
    .multi()
    .sadd(presenceKey(userId), config.SERVER_ID)
    .expire(presenceKey(userId), config.PRESENCE_TTL_SECONDS)
    .exec();
}

/** Called when a user's LAST socket on this server closes. */
export async function clearPresence(userId: string): Promise<void> {
  onlineUsers.delete(userId);
  await redis.srem(presenceKey(userId), config.SERVER_ID);
}

/**
 * Deliver a message to a recipient wherever they are:
 *   - if they are on THIS server, push directly (no Redis hop needed);
 *   - otherwise look up their server(s) and publish to those channels.
 * Returns the set of servers we routed to (for logging/tests).
 */
export async function routeToUser(env: DeliveryEnvelope): Promise<string[]> {
  const routedTo: string[] = [];

  // Fast path: recipient is on this very server.
  if (local.has(env.targetUserId)) {
    local.deliverLocal(env.targetUserId, {
      type: 'message',
      message: env.message,
      viaServer: config.SERVER_ID,
    });
    routedTo.push(config.SERVER_ID);
    return routedTo;
  }

  // Look up where the recipient is connected.
  const servers = await redis.smembers(presenceKey(env.targetUserId));
  if (servers.length === 0) {
    // Recipient is offline everywhere. Message stays durable in Postgres; they
    // will get it via history on reconnect. (A real app also fires a push here.)
    return routedTo;
  }
  const payload = JSON.stringify(env);
  const pipe = publisher.pipeline();
  for (const s of servers) {
    pipe.publish(channelFor(s), payload);
    routedTo.push(s);
  }
  await pipe.exec();
  return routedTo;
}

export async function stopRouting(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  // Best-effort: drop this server from all locally-known users' presence sets.
  const pipe = redis.pipeline();
  for (const userId of onlineUsers) pipe.srem(presenceKey(userId), config.SERVER_ID);
  await pipe.exec().catch(() => undefined);
  await subscriber.unsubscribe(myChannel).catch(() => undefined);
}
