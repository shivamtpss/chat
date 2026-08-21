import { ulid } from 'ulid';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../src/db/migrate.js';
import { pool, closePool } from '../src/db/pool.js';
import { redis, closeRedis } from '../src/db/redis.js';
import { ensureGroup, publish, pendingCount, streamLength } from '../src/bus/bus.js';
import { upsertUser, createGroup } from '../src/db/repo.js';
import type { BusJob } from '../src/bus/protocol.js';

/**
 * DEMO: durability + replay after downtime.
 *
 * This is the thing Stage 03's fire-and-forget pub/sub could NOT do. We:
 *   1. publish N messages to the bus with NO worker running,
 *   2. show they sit safely in the durable log (nothing lost, nothing persisted yet),
 *   3. start a worker,
 *   4. watch it drain the backlog and persist everything to Postgres.
 *
 * Run (infra up, but do NOT start a worker yourself):
 *   npm run demo:replay
 */
const __dirname = dirname(fileURLToPath(import.meta.url));

async function countPersisted(conversationId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM messages WHERE conversation_id=$1',
    [conversationId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  await migrate();
  await ensureGroup();

  // Fresh state for a clean demo.
  await redis.del(process.env.BUS_STREAM ?? 'chat:messages');
  await ensureGroup();

  const alice = await upsertUser('replay_alice', 'Alice');
  const bob = await upsertUser('replay_bob', 'Bob');
  const conversationId = await createGroup('replay-demo', [alice.id, bob.id]);

  const N = 25;
  console.log(`\n1) Publishing ${N} messages to the bus with NO worker running...`);
  for (let i = 0; i < N; i++) {
    const job: BusJob = {
      conversationId,
      senderId: alice.id,
      clientMsgId: ulid(),
      body: `offline message ${i + 1}`,
      originServer: 'demo',
    };
    await publish(job as unknown as Record<string, string>);
  }

  console.log(`   bus log length:      ${await streamLength()}  (durable, waiting)`);
  console.log(`   pending (unacked):   ${await pendingCount()}`);
  console.log(`   persisted in Postgres: ${await countPersisted(conversationId)}  <- still zero, no worker yet`);
  console.log('\n   >>> In Stage 03 (pub/sub) these 25 messages would be GONE (no subscriber). Here they are safe.');

  console.log('\n2) Starting a worker now...');
  const worker: ChildProcess = spawn(
    process.execPath,
    ['--no-warnings', '--loader', 'ts-node/esm', join(__dirname, '..', 'src', 'worker', 'index.ts')],
    { env: { ...process.env, WORKER_ID: 'replay-worker', LOG_LEVEL: 'warn' }, stdio: 'inherit' },
  );

  // Wait for the worker to drain the backlog.
  let persisted = 0;
  for (let i = 0; i < 30; i++) {
    await delay(500);
    persisted = await countPersisted(conversationId);
    if (persisted >= N) break;
  }

  console.log(`\n3) After the worker ran:`);
  console.log(`   persisted in Postgres: ${persisted}`);
  console.log(`   pending (unacked):   ${await pendingCount()}`);

  worker.kill('SIGINT');
  await delay(300);

  if (persisted === N) {
    console.log(`\nSUCCESS: all ${N} messages published while offline were REPLAYED and persisted.`);
  } else {
    console.log(`\nINCOMPLETE: expected ${N}, got ${persisted}.`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis();
    await closePool();
  });
