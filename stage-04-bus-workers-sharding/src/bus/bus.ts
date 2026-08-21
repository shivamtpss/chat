import { redis, blocking } from '../db/redis.js';
import { config } from '../lib/config.js';
import { makeLogger } from '../lib/logger.js';

const logger = makeLogger('bus');

/**
 * A tiny durable message bus built on Redis Streams.
 *
 * WHY a stream and not plain pub/sub (Stage 03)?
 *   - pub/sub is fire-and-forget: if no consumer is listening at that instant,
 *     the message is gone forever.
 *   - a stream is a durable, append-only LOG. Messages sit in the log until a
 *     consumer group acknowledges them. If every worker is down, the messages
 *     WAIT. When a worker comes back, it reads what it missed. That is "replay".
 *
 * This is the same mental model as Kafka (topics, consumer groups, offsets,
 * acks); Redis Streams is just an easy, no-extra-service way to learn it.
 */

export interface BusMessage {
  /** Redis Stream entry id, e.g. "1712345678901-0". Used to ack. */
  id: string;
  /** The application payload we published. */
  payload: Record<string, string>;
}

/** Ensure the consumer group exists (idempotent). Call once at startup. */
export async function ensureGroup(): Promise<void> {
  try {
    // MKSTREAM creates the stream if missing; '0' means the group starts at the
    // beginning so nothing already in the log is skipped.
    await redis.xgroup('CREATE', config.BUS_STREAM, config.BUS_GROUP, '0', 'MKSTREAM');
    logger.info({ stream: config.BUS_STREAM, group: config.BUS_GROUP }, 'consumer group created');
  } catch (err) {
    if ((err as Error).message.includes('BUSYGROUP')) {
      logger.info('consumer group already exists');
    } else {
      throw err;
    }
  }
}

/** Publish (append) a message to the durable log. Returns the stream entry id. */
export async function publish(payload: Record<string, string>): Promise<string> {
  const flat: string[] = [];
  for (const [k, v] of Object.entries(payload)) flat.push(k, v);
  // MAXLEN ~ caps the log so it cannot grow unbounded in this demo. Real systems
  // set retention by time/size. '~' means approximate (cheaper) trimming.
  const id = await redis.xadd(config.BUS_STREAM, 'MAXLEN', '~', 100_000, '*', ...flat);
  return id!;
}

/**
 * Read the next batch for THIS consumer within the group. Blocks up to
 * blockMs waiting for new entries. Returns [] on timeout.
 *
 * Consumer-group semantics: each entry is delivered to exactly ONE consumer in
 * the group. Add more workers with different consumer names and the log is
 * shared out among them, that is horizontal scaling of processing.
 */
export async function readBatch(
  consumerName: string,
  count: number,
  blockMs: number,
): Promise<BusMessage[]> {
  const res = (await blocking.xreadgroup(
    'GROUP',
    config.BUS_GROUP,
    consumerName,
    'COUNT',
    count,
    'BLOCK',
    blockMs,
    'STREAMS',
    config.BUS_STREAM,
    '>', // '>' = only entries never delivered to any consumer in this group
  )) as Array<[string, Array<[string, string[]]>]> | null;

  if (!res || res.length === 0) return [];
  const entries = res[0]![1];
  return entries.map(([id, fields]) => {
    const payload: Record<string, string> = {};
    for (let i = 0; i < fields.length; i += 2) payload[fields[i]!] = fields[i + 1]!;
    return { id, payload };
  });
}

/** Acknowledge an entry so it is removed from the pending list (done). */
export async function ack(id: string): Promise<void> {
  await redis.xack(config.BUS_STREAM, config.BUS_GROUP, id);
}

/** How many entries are published but not yet acked (the backlog). */
export async function pendingCount(): Promise<number> {
  const res = (await redis.xpending(config.BUS_STREAM, config.BUS_GROUP)) as [number, ...unknown[]];
  return Array.isArray(res) ? Number(res[0] ?? 0) : 0;
}

/** Total entries currently in the stream log. */
export async function streamLength(): Promise<number> {
  return redis.xlen(config.BUS_STREAM);
}
