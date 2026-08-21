import { Redis } from 'ioredis';
import { config } from '../lib/config.js';
import { makeLogger } from '../lib/logger.js';

const logger = makeLogger('redis');

/**
 * Redis clients. In Stage 04 Redis does double duty:
 *   - `redis`      : normal commands (routing directory, presence, Stream ops)
 *   - `publisher`  : pub/sub delivery to gateways (same idea as Stage 03)
 *   - `subscriber` : pub/sub receive
 *   - `blocking`   : a DEDICATED connection for XREADGROUP BLOCK (a blocking
 *                    read parks the connection, so it must not be shared).
 */
function make(label: string): Redis {
  const client = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  client.on('error', (err) => logger.error({ err, label }, 'redis error'));
  return client;
}

export const redis = make('cmd');
export const publisher = make('pub');
export const subscriber = make('sub');
export const blocking = make('block');

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), publisher.quit(), subscriber.quit(), blocking.quit()]);
}
