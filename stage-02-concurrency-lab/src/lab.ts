import { closePool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { hr } from './lib/load.js';
import { run as exp1 } from './experiments/01-pool-size.js';
import { run as exp2 } from './experiments/02-slow-query-drain.js';
import { run as exp3 } from './experiments/03-event-loop-blocking.js';
import { run as exp4 } from './experiments/04-throughput-curve.js';

const MENU = `
Stage 02 Concurrency Lab
  1  Pool size vs concurrency      (the "phone lines" lesson)
  2  Slow query drains the pool    (+ statement_timeout defense)
  3  Event-loop blocking vs async  (one greedy request freezes all)
  4  Throughput vs concurrency     (find the sweet spot / knee)

Usage: npm run lab <1-4 | all>
`;

async function main(): Promise<void> {
  await migrate();
  const arg = (process.argv[2] ?? '').toLowerCase();

  if (!arg) {
    console.log(MENU);
    return;
  }

  const runs: Record<string, () => Promise<void>> = {
    '1': exp1,
    '2': exp2,
    '3': exp3,
    '4': exp4,
  };

  if (arg === 'all') {
    for (const key of ['1', '2', '3', '4']) await runs[key]!();
    hr();
    console.log('All experiments complete. Re-run any single one with: npm run lab <n>');
    return;
  }

  const fn = runs[arg];
  if (!fn) {
    console.log(MENU);
    return;
  }
  await fn();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
