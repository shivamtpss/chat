import { ulid } from 'ulid';
import { migrate } from '../src/db/migrate.js';
import { pool, closePool } from '../src/db/pool.js';
import { closeRedis } from '../src/db/redis.js';
import { config } from '../src/lib/config.js';
import {
  upsertUser,
  createGroup,
  persistMessage,
  partitionForConversation,
  countByPartition,
} from '../src/db/repo.js';

/**
 * DEMO: sharding / partitioning by conversation_id.
 *
 * Shows two things:
 *   1. Different conversations land in different physical partitions (the hash
 *      of conversation_id decides which one), spreading load.
 *   2. Every message of ONE conversation lands in the SAME partition, and its
 *      per-conversation seq is a clean 1,2,3,... so ordered reads stay cheap.
 *
 * This needs no gateway/worker; it writes via the repo directly. Run:
 *   npm run demo:sharding
 */
async function main(): Promise<void> {
  await migrate();

  const alice = await upsertUser('shard_alice', 'Alice');

  console.log(`\nPartitions configured: ${config.MESSAGE_PARTITIONS}`);
  console.log('\n1) Creating 8 conversations and writing messages to each...');

  const convs: string[] = [];
  for (let c = 0; c < 8; c++) {
    const convId = await createGroup(`shard-demo-${c}`, [alice.id]);
    convs.push(convId);
    // Write a few messages so each conversation has ordered seqs.
    for (let m = 0; m < 5; m++) {
      await persistMessage({
        conversationId: convId,
        senderId: alice.id,
        clientMsgId: ulid(),
        body: `conv ${c} msg ${m + 1}`,
      });
    }
  }

  console.log('\n2) Which partition holds each conversation:');
  for (let i = 0; i < convs.length; i++) {
    const part = await partitionForConversation(convs[i]!);
    console.log(`   conversation ${i}  ->  ${part}`);
  }

  console.log('\n3) Row counts per physical partition (load is spread):');
  for (const row of await countByPartition()) {
    console.log(`   ${row.partition.padEnd(14)} ${row.count} rows`);
  }

  console.log('\n4) Ordering within one conversation (seq is 1..5, single partition):');
  const { rows } = await pool.query<{ seq: string; body: string; partition: string }>(
    `SELECT seq::text AS seq, body, tableoid::regclass::text AS partition
     FROM messages WHERE conversation_id=$1 ORDER BY seq ASC`,
    [convs[0]],
  );
  for (const r of rows) console.log(`   seq=${r.seq}  ${r.body}   [${r.partition}]`);

  const partitions = new Set(rows.map((r) => r.partition));
  console.log(
    `\n   -> conversation 0 lives in exactly ${partitions.size} partition (as it should), with ordered seq.`,
  );

  console.log('\nTakeaway: hash(conversation_id) picks the partition. A conversation stays');
  console.log('together (cheap ordered reads); different conversations spread across partitions');
  console.log('(load sharding). Same key would spread across MACHINES in Cassandra/Scylla.');
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
