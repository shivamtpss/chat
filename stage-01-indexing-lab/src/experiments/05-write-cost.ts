import { ulid } from 'ulid';
import { query } from '../db/pool.js';
import { createIndex, dropIndex, tableStats, hr } from '../lib/explain.js';

/**
 * EXPERIMENT 5: The write-cost of indexes.
 *
 * Indexes speed reads but slow writes, because every INSERT must also update
 * every index. We measure insert throughput with 0, 1, and 3 indexes, and show
 * how much disk the indexes add. This is WHY we do not index every column.
 */
export async function run(): Promise<void> {
  hr();
  console.log('EXPERIMENT 5: Write-cost of indexes (why not index everything)');
  console.log('Lesson: each index makes every INSERT do more work and uses disk.');
  hr();

  async function insertBatch(count: number): Promise<number> {
    const conv = ulid();
    const sender = ulid();
    const start = process.hrtime.bigint();
    const batch = 1000;
    for (let made = 0; made < count; made += batch) {
      const n = Math.min(batch, count - made);
      const values: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (let j = 0; j < n; j++) {
        values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
        params.push(ulid(), conv, sender, `write-cost test ${made + j}`);
      }
      await query(
        `INSERT INTO messages(id, conversation_id, sender_id, body) VALUES ${values.join(',')}`,
        params,
      );
    }
    return Number(process.hrtime.bigint() - start) / 1e6;
  }

  const N = 20_000;

  // 0 indexes (besides PK).
  await dropIndex('ix_lab_conv_id');
  await dropIndex('ix_lab_sender');
  await dropIndex('ix_lab_created');
  const t0 = await insertBatch(N);
  const s0 = await tableStats();

  // 1 index.
  await createIndex('CREATE INDEX ix_lab_conv_id ON messages (conversation_id, id DESC)');
  const t1 = await insertBatch(N);
  const s1 = await tableStats();

  // 3 indexes.
  await createIndex('CREATE INDEX ix_lab_sender ON messages (sender_id)');
  await createIndex('CREATE INDEX ix_lab_created ON messages (created_at)');
  const t3 = await insertBatch(N);
  const s3 = await tableStats();

  const perRow = (ms: number): string => ((ms / N) * 1000).toFixed(1);
  console.log(`\n  Inserting ${N} rows each time:`);
  console.log(`    0 secondary indexes: ${t0.toFixed(0)} ms  (${perRow(t0)} us/row)  index size ${s0.indexSize}`);
  console.log(`    1 secondary index:   ${t1.toFixed(0)} ms  (${perRow(t1)} us/row)  index size ${s1.indexSize}`);
  console.log(`    3 secondary indexes: ${t3.toFixed(0)} ms  (${perRow(t3)} us/row)  index size ${s3.indexSize}`);
  console.log('\n  Takeaway: writes get slower and disk grows with each index. Index for the');
  console.log('  queries you actually run, not speculatively. Chat is write-heavy, so this matters.');

  // Clean up extra indexes so later runs are consistent.
  await dropIndex('ix_lab_sender');
  await dropIndex('ix_lab_created');
}
