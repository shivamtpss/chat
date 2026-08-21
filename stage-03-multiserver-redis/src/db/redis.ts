import { Redis } from 'ioredis';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

/**
 * Redis clients.
 *
 * A subtle but important rule: a Redis connection that is in "subscriber mode"
 * cannot run normal commands. So we keep THREE connections:
 *   - `redis`     : normal commands (routing directory reads/writes, presence)
 *   - `publisher` : publishing pub/sub messages
 *   - `subscriber`: receiving pub/sub messages
 * publisher/subscriber could technically share, but keeping them separate is the
 * clean, conventional setup and avoids mode conflicts.
 */
function make(label: string): Redis {
  const client = new Redis(config.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  });
  client.on('error', (err) => logger.error({ err, label }, 'redis error'));
  return client;
}

export const redis = make('cmd');
export const publisher = make('pub');
export const subscriber = make('sub');

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), publisher.quit(), subscriber.quit()]);
}
