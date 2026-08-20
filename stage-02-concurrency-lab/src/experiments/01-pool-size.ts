import { makePool } from '../db/pool.js';
import { getConvId } from '../lib/data.js';
import { runLoad, printResult, hr } from '../lib/load.js';

/**
 * EXPERIMENT 1: Connection pool size vs concurrency.
 *
 * Beginner framing: a "connection pool" is a small set of phone lines to the
 * database, shared by everyone. If 200 users call at once but you only have 5
 * lines, 195 people wait on hold. More lines help, up to a point (the database
 * itself has limits).
 *
 * We send the SAME load (same query, same number of requests, same concurrency)
 * through pools of different sizes and watch throughput and the p99 tail.
 */
export async function run(): Promise<void> {
  hr();
  console.log('EXPERIMENT 1: Pool size vs concurrency (the "phone lines" lesson)');
  console.log('Same load (2000 requests, 200 at a time). Only the pool size changes.');
  hr();

  const convId = await getConvId(0);
  const REQUESTS = 2000;
  const CONCURRENCY = 200;

  const query = async (poolMax: number): Promise<void> => {
    const pool = makePool({ max: poolMax, connectionTimeoutMillis: 10_000 });
    try {
      const result = await runLoad(REQUESTS, CONCURRENCY, async () => {
        await pool.query(
          'SELECT id, body FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 50',
          [convId],
        );
      });
      printResult(`pool max = ${poolMax}`, result);
    } finally {
      await pool.end();
    }
  };

  for (const size of [1, 5, 20, 50]) {
    await query(size);
  }

  console.log('\n  What to notice:');
  console.log('   - pool=1 serializes everything: lowest throughput, worst p99 (everyone queues).');
  console.log('   - throughput climbs as the pool grows, because more queries truly run at once.');
  console.log('   - but it plateaus: past a point the DB (CPU, max_connections) is the limit,');
  console.log('     not your pool. Bigger pool then just adds waiting elsewhere.');
  console.log('\n  Real world: this is why apps set a sensible pool size (often 10-30 per instance)');
  console.log('  and add PgBouncer to funnel many app connections into few DB connections.');
}
