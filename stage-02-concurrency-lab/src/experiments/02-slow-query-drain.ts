import { makePool } from '../db/pool.js';
import { getConvId } from '../lib/data.js';
import { runLoad, printResult, hr } from '../lib/load.js';

/**
 * EXPERIMENT 2: One slow query drains the pool (and how to defend).
 *
 * Beginner framing: back to the "phone lines" analogy. A handful of callers
 * each grab a line and then... just stay on the line doing nothing for 5
 * seconds (a slow query). Now the fast callers can't get a line at all, even
 * though their own request would take 1 ms. A few slow requests poison the
 * whole system. This is one of the most common real-world outages.
 *
 * We mix a few slow queries (pg_sleep) into a flood of fast ones, once WITHOUT
 * a statement timeout (fast users suffer) and once WITH one (slow queries get
 * cancelled, fast users are protected).
 */
export async function run(): Promise<void> {
  hr();
  console.log('EXPERIMENT 2: One slow query drains the pool');
  console.log('A few 3-second queries vs a flood of 1ms queries, sharing a small pool.');
  hr();

  const convId = await getConvId(0);
  const POOL = 10;
  const FAST_REQUESTS = 500;
  const SLOW_REQUESTS = 10; // only ten! but they hog connections
  const CONCURRENCY = 60;

  async function scenario(label: string, statementTimeoutMs?: number): Promise<void> {
    const opts =
      statementTimeoutMs !== undefined
        ? { max: POOL, connectionTimeoutMillis: 8_000, statementTimeoutMillis: statementTimeoutMs }
        : { max: POOL, connectionTimeoutMillis: 8_000 };
    const pool = makePool(opts);

    // Build a task list: mostly fast, a few slow, shuffled together.
    const tasks: Array<'fast' | 'slow'> = [];
    for (let i = 0; i < FAST_REQUESTS; i++) tasks.push('fast');
    for (let i = 0; i < SLOW_REQUESTS; i++) tasks.push('slow');
    for (let i = tasks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tasks[i], tasks[j]] = [tasks[j]!, tasks[i]!];
    }
    let cursor = 0;

    try {
      const result = await runLoad(tasks.length, CONCURRENCY, async () => {
        const kind = tasks[cursor++];
        if (kind === 'slow') {
          await pool.query('SELECT pg_sleep(3)'); // a runaway/expensive query
        } else {
          await pool.query(
            'SELECT id, body FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 50',
            [convId],
          );
        }
      });
      printResult(label, result);
    } finally {
      await pool.end();
    }
  }

  await scenario('WITHOUT statement_timeout (fast users held hostage)');
  await scenario('WITH statement_timeout = 500ms (slow queries cancelled)', 500);

  console.log('\n  What to notice:');
  console.log('   - Without a timeout, the p99 for EVERYONE explodes toward ~3s, because the');
  console.log('     10 slow queries hold connections and fast queries wait behind them.');
  console.log('   - With a 500ms statement_timeout, the slow queries fail fast (you see failures),');
  console.log('     connections are freed, and the fast majority stay quick. You sacrificed the');
  console.log('     10 bad requests to protect the 500 good ones.');
  console.log('\n  Real world: always bound query time (statement_timeout) and connection wait');
  console.log('  (connectionTimeoutMillis). A single runaway query should never take the app down.');
}
