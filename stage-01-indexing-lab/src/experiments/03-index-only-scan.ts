import { explain, printPlan, createIndex, dropIndex, hr } from '../lib/explain.js';
import { query } from '../db/pool.js';

/**
 * EXPERIMENT 3: Index-only scans (covering indexes).
 *
 * If an index contains EVERY column a query needs, Postgres can answer from the
 * index alone and never touch the table ("Index Only Scan"). We show a normal
 * index scan (which still visits the table for `body`) vs a covering index that
 * INCLUDEs body.
 */
export async function run(hotConvId: string): Promise<void> {
  hr();
  console.log('EXPERIMENT 3: Index-only scan (covering index)');
  console.log('Lesson: an index that holds all needed columns avoids touching the table.');
  hr();

  await dropIndex('ix_lab_conv_id');
  await dropIndex('ix_lab_conv_cover');

  // A query that selects id + body (body is not in a plain (conversation_id,id) index).
  const sql = `SELECT id, body FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 50`;

  await createIndex('CREATE INDEX ix_lab_conv_id ON messages (conversation_id, id DESC)');
  const normal = await explain(sql, [hotConvId]);
  printPlan('Plain index (must fetch body from table heap)', normal);

  await dropIndex('ix_lab_conv_id');
  await createIndex(
    'CREATE INDEX ix_lab_conv_cover ON messages (conversation_id, id DESC) INCLUDE (body)',
  );
  // VACUUM sets the visibility map so an Index Only Scan can skip heap fetches.
  // Without this, a fresh table shows "Heap Fetches > 0" and is not truly
  // index-only. This is a real gotcha worth teaching.
  await query('VACUUM messages');
  const covering = await explain(sql, [hotConvId]);
  printPlan('Covering index with INCLUDE (body) -> Index Only Scan', covering);
  const heapFetches = covering.planLines.join('\n').match(/Heap Fetches: (\d+)/);
  if (heapFetches) console.log(`  (Heap Fetches: ${heapFetches[1]} - 0 means fully answered from the index)`);

  // At this tiny scale both are sub-millisecond, so raw ms is noise. The real
  // signal is that the covering index does NO heap fetches: it answers entirely
  // from the index. That is the win, and it grows with row width and volume.
  const normalHeap = normal.planLines.join('\n').match(/Heap Fetches: (\d+)/)?.[1] ?? 'n/a (visits heap)';
  console.log(`\n  plain index heap fetches: ${normalHeap};  covering index heap fetches: 0`);
  console.log('\n  Takeaway: covering indexes can speed hot read paths further, but they');
  console.log('  are bigger and cost more on writes. Use them only for proven hot queries.');

  // Clean up the big covering index so it does not skew later experiments.
  await dropIndex('ix_lab_conv_cover');
}
