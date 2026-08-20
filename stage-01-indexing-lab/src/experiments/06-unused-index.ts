import { query } from '../db/pool.js';
import { createIndex, dropIndex, hr } from '../lib/explain.js';

/**
 * EXPERIMENT 6: Finding UNUSED indexes.
 *
 * An index that no query uses is pure cost: it slows writes and eats disk for
 * zero benefit. Postgres tracks how many times each index was scanned in
 * pg_stat_user_indexes. We create a deliberately useless index, run some
 * queries, then read the stats to spot the freeloader.
 */
export async function run(hotConvId: string): Promise<void> {
  hr();
  console.log('EXPERIMENT 6: Detecting unused indexes');
  console.log('Lesson: an index nothing queries is all cost and no benefit. Find and drop it.');
  hr();

  // Reset stats so the numbers are about THIS run.
  await query(`SELECT pg_stat_reset()`);

  // A useful index (used by our hot query) and a useless one (on display_name
  // of users, which nothing here queries by).
  await dropIndex('ix_lab_conv_id');
  await query('DROP INDEX IF EXISTS ix_lab_users_display');
  await createIndex('CREATE INDEX ix_lab_conv_id ON messages (conversation_id, id DESC)');
  await query('CREATE INDEX ix_lab_users_display ON users (display_name)');

  // Run the hot query several times so the useful index accrues scans.
  for (let i = 0; i < 20; i++) {
    await query(
      `SELECT id, body FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 50`,
      [hotConvId],
    );
  }

  // Stats are flushed asynchronously. Force a flush (PG15+) so the counts below
  // are accurate; fall back to a short wait on older versions.
  try {
    await query('SELECT pg_stat_force_next_flush()');
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }

  const { rows } = await query<{ indexrelname: string; idx_scan: string }>(
    `SELECT indexrelname, idx_scan::text AS idx_scan
     FROM pg_stat_user_indexes
     WHERE indexrelname LIKE 'ix_lab_%'
     ORDER BY idx_scan ASC`,
  );

  console.log('\n  Index scan counts since reset:');
  for (const r of rows) {
    const flag = Number(r.idx_scan) === 0 ? '   <-- UNUSED, candidate to DROP' : '';
    console.log(`    ${r.indexrelname.padEnd(24)} scans=${r.idx_scan}${flag}`);
  }

  console.log('\n  Takeaway: periodically check pg_stat_user_indexes. Drop indexes with 0 scans');
  console.log('  (after observing a representative period). Fewer indexes = faster writes.');

  // Clean up the useless one.
  await query('DROP INDEX IF EXISTS ix_lab_users_display');
}
