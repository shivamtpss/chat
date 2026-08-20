import { query } from '../db/pool.js';
import { explain, printPlan, verdict, createIndex, dropIndex, hr } from '../lib/explain.js';

/**
 * EXPERIMENT 1: Seq Scan vs Index Scan.
 *
 * The single most important lesson. We run the hot query WITHOUT an index
 * (Postgres must scan the whole table), then add the index and run again
 * (Postgres jumps straight to the rows).
 */
export async function run(hotConvId: string): Promise<void> {
  hr();
  console.log('EXPERIMENT 1: Seq Scan vs Index Scan');
  console.log('Query: newest 50 messages of one conversation (the core chat query).');
  hr();

  const sql = `SELECT id, body FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 50`;

  // Make sure we start clean.
  await dropIndex('ix_lab_conv_id');

  const before = await explain(sql, [hotConvId]);
  printPlan('BEFORE: no index', before);
  console.log('\n  Notice: "Seq Scan" means Postgres read the WHOLE messages table');
  console.log('  and then sorted, just to return 50 rows. This is the slow path.');

  const buildMs = await createIndex(
    'CREATE INDEX ix_lab_conv_id ON messages (conversation_id, id DESC)',
  );
  console.log(`\n  ...created index (conversation_id, id DESC) in ${buildMs.toFixed(0)} ms...`);

  const after = await explain(sql, [hotConvId]);
  printPlan('AFTER: with composite index', after);
  console.log('\n  Notice: "Index Scan" - Postgres jumps to this conversation\'s rows,');
  console.log('  already ordered by id DESC, and stops after 50. No full scan, no sort.');

  verdict(before, after);

  // Leave the index in place for later experiments; experiment 2 will manage
  // its own indexes explicitly.
  void query;
}
