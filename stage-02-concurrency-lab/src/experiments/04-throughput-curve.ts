import { makePool } from '../db/pool.js';
import { getConvId } from '../lib/data.js';
import { runLoad, fmt, hr } from '../lib/load.js';

/**
 * EXPERIMENT 4: Throughput vs concurrency (finding the sweet spot).
 *
 * Beginner framing: more simultaneous users does NOT mean more work done. Every
 * system has a sweet spot. Below it you are underusing capacity; above it you
 * just pile up a queue, so latency climbs while throughput stops improving.
 * This experiment ramps concurrency and prints the curve so you can SEE the
 * knee where adding load stops helping.
 */
export async function run(): Promise<void> {
  hr();
  console.log('EXPERIMENT 4: Throughput vs concurrency (the sweet-spot curve)');
  console.log('Fixed pool (max=20). We ramp how many requests run at once and watch the curve.');
  hr();

  const convId = await getConvId(0);
  const pool = makePool({ max: 20, connectionTimeoutMillis: 10_000 });
  const REQUESTS = 3000;

  console.log('\n  concurrency |  throughput (ops/s) |   p50 ms |   p99 ms');
  console.log('  ------------+---------------------+----------+---------');

  try {
    for (const c of [1, 5, 10, 20, 50, 100, 200, 400]) {
      const r = await runLoad(REQUESTS, c, async () => {
        await pool.query(
          'SELECT id, body FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 50',
          [convId],
        );
      });
      console.log(
        `  ${String(c).padStart(11)} | ${fmt(r.throughput).padStart(19)} | ${fmt(r.p50).padStart(8)} | ${fmt(r.p99).padStart(8)}`,
      );
    }
  } finally {
    await pool.end();
  }

  console.log('\n  What to notice:');
  console.log('   - Throughput rises as concurrency increases, but with DIMINISHING returns.');
  console.log('   - Meanwhile p50/p99 latency climb the whole time. Notice p50 goes from');
  console.log('     ~1 ms at low concurrency to tens of ms at high concurrency.');
  console.log('   - The "knee" is where extra concurrency buys little throughput but keeps');
  console.log('     adding latency. On a bigger box the knee is higher; load-test to find YOURS.');
  console.log('\n  Real world: find your knee, then size pools/instances around it. Blindly');
  console.log('  cranking concurrency mostly makes users wait longer for similar throughput.');
}
