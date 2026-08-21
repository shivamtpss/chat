import { redis, publisher, subscriber } from '../db/redis.js';
import { config } from '../lib/config.js';
import { makeLogger } from '../lib/logger.js';
import type { ServerMessage } from './protocol.js';

const logger = makeLogger('routing');

/**
 * Redis routing directory + pub/sub delivery (carried over from Stage 03).
 *
 * Split of responsibilities in Stage 04:
 *   - GATEWAYS own the sockets and the presence directory (who is on which
 *     gateway), and SUBSCRIBE to their own channel to receive things to push.
 *   - WORKERS persist messages, then PUBLISH the finished message (and the
 *     sender's durable ack) to the right gateway channel via this directory.
 *
 * The envelope carries a ready-to-send ServerMessage plus the target user, so
 * the same path delivers both "here is a new message" (to recipients) and
 * "your message is saved" (the ack, back to the sender).
 */

const channelFor = (serverId: string): string => `server:${serverId}`;
const presenceKey = (userId: string): string => `presence:${userId}`;

export interface Envelope {
  targetUserId: string;
  serverMessage: ServerMessage;
}

// ---- gateway side ----

export async function startGatewaySubscriber(
  serverId: string,
  onDeliver: (targetUserId: string, msg: ServerMessage) => void,
): Promise<void> {
  const channel = channelFor(serverId);
  await subscriber.subscribe(channel);
  subscriber.on('message', (ch, raw) => {
    if (ch !== channel) return;
    try {
      const env = JSON.parse(raw) as Envelope;
      onDeliver(env.targetUserId, env.serverMessage);
    } catch {
      logger.warn({ raw }, 'bad envelope');
    }
  });
  logger.info({ channel }, 'gateway subscribed to its delivery channel');
}

export async function registerPresence(userId: string, serverId: string): Promise<void> {
  await redis
    .multi()
    .sadd(presenceKey(userId), serverId)
    .expire(presenceKey(userId), config.PRESENCE_TTL_SECONDS)
    .exec();
}

export async function refreshPresence(userIds: Iterable<string>, serverId: string): Promise<void> {
  const pipe = redis.pipeline();
  let any = false;
  for (const userId of userIds) {
    any = true;
    pipe.sadd(presenceKey(userId), serverId);
    pipe.expire(presenceKey(userId), config.PRESENCE_TTL_SECONDS);
  }
  if (any) await pipe.exec();
}

export async function clearPresence(userId: string, serverId: string): Promise<void> {
  await redis.srem(presenceKey(userId), serverId);
}

// ---- worker side ----

/**
 * Deliver a ServerMessage to a user wherever they are connected. Looks up their
 * gateway(s) and publishes to those channels. Returns the servers routed to
 * (empty = user offline; for a chat message that is fine because it is durable
 * in Postgres and fetched via history on reconnect).
 */
export async function deliverToUser(targetUserId: string, msg: ServerMessage): Promise<string[]> {
  const servers = await redis.smembers(presenceKey(targetUserId));
  if (servers.length === 0) return [];
  const env: Envelope = { targetUserId, serverMessage: msg };
  const payload = JSON.stringify(env);
  const pipe = publisher.pipeline();
  for (const s of servers) pipe.publish(channelFor(s), payload);
  await pipe.exec();
  return servers;
}
