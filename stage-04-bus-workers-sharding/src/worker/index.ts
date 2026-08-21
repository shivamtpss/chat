import { config } from '../lib/config.js';
import { makeLogger } from '../lib/logger.js';
import { migrate } from '../db/migrate.js';
import { closePool } from '../db/pool.js';
import { closeRedis } from '../db/redis.js';
import { ensureGroup, readBatch, ack, pendingCount } from '../bus/bus.js';
import { deliverToUser } from '../bus/routing.js';
import { persistMessage, memberIdsExcept } from '../db/repo.js';
import type { BusJob, ServerMessage } from '../bus/protocol.js';

const consumerName = config.WORKER_ID;
const logger = makeLogger(`worker:${consumerName}`);

let running = true;

/**
 * A worker: the background muscle of Stage 04.
 *
 * Loop: read a batch from the durable bus -> for each job, PERSIST to Postgres
 * (idempotent, assigns per-conversation seq) -> DELIVER the message to online
 * recipients and the durable ack to the sender -> ACK the bus entry so it is
 * marked done. If the worker crashes before acking, the entry stays pending and
 * is retried. If ALL workers are down, jobs pile up in the log and are
 * processed when a worker returns (replay).
 *
 * Scale by running more workers with different WORKER_ID: the consumer group
 * shares the log out among them automatically.
 */
async function processJob(id: string, job: BusJob): Promise<void> {
  const { message, deduped } = await persistMessage({
    conversationId: job.conversationId,
    senderId: job.senderId,
    clientMsgId: job.clientMsgId,
    body: job.body,
  });

  // Durable ack back to the original sender (routed to whatever gateway they
  // are on now, which may differ from originServer after a reconnect).
  const senderAck: ServerMessage = {
    type: 'ack',
    clientMsgId: job.clientMsgId,
    messageId: message.id,
    seq: message.seq,
    createdAt: message.created_at,
    deduped,
  };
  await deliverToUser(job.senderId, senderAck);

  // If this was a duplicate (retry), do not fan out again.
  if (!deduped) {
    const recipients = await memberIdsExcept(job.conversationId, job.senderId);
    const outbound: ServerMessage = {
      type: 'message',
      viaServer: consumerName,
      message: {
        id: message.id,
        conversationId: message.conversation_id,
        senderId: message.sender_id,
        seq: message.seq,
        body: message.body,
        createdAt: message.created_at,
      },
    };
    await Promise.all(recipients.map((rid) => deliverToUser(rid, outbound)));
  }
}

async function loop(): Promise<void> {
  while (running) {
    const batch = await readBatch(consumerName, 20, 2000);
    if (batch.length === 0) continue;
    for (const entry of batch) {
      try {
        const job = entry.payload as unknown as BusJob;
        await processJob(entry.id, job);
        await ack(entry.id); // only ack AFTER durable persist + delivery attempt
      } catch (err) {
        // Do NOT ack: the entry stays pending and will be retried. In a real
        // system a poison message would eventually go to a dead-letter stream.
        logger.error({ err, id: entry.id }, 'job failed, left pending for retry');
      }
    }
  }
}

async function main(): Promise<void> {
  await migrate();
  await ensureGroup();
  const backlog = await pendingCount();
  logger.info({ backlog }, 'worker started, consuming bus');
  void loop();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down worker');
    running = false;
    await new Promise((r) => setTimeout(r, 100));
    await closeRedis();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
