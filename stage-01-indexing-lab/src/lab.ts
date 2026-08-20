import { query, closePool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { tableStats, hr } from './lib/explain.js';
import { run as exp1 } from './experiments/01-seqscan-vs-index.js';
import { run as exp2 } from './experiments/02-composite-order.js';
import { run as exp3 } from './experiments/03-index-only-scan.js';
import { run as exp4 } from './experiments/04-offset-vs-keyset.js';
import { run as exp5 } from './experiments/05-write-cost.js';
import { run as exp6 } from './experiments/06-unused-index.js';

/**
 * Lab entry point.
 *   npm run lab            -> prints the menu
 *   npm run lab 1          -> run experiment 1
 *   npm run lab all        -> run all experiments in order
 */
const MENU = `
Stage 01 Indexing Lab
  1  Seq Scan vs Index Scan        (the core lesson)
  2  Composite index column order  (why conversation_id goes first)
  3  Index-only scan (covering)    (answer from the index alone)
  4  OFFSET vs keyset pagination   (why LIMIT is not enough)
  5  Write-cost of indexes         (why not index everything)
  6  Detect unused indexes         (find freeloaders and drop them)

Usage: npm run lab <1-6 | all>
`;

async function getConvId(idx: number): Promise<string> {
  const { rows } = await query<{ conversation_id: string }>(
    'SELECT conversation_id FROM lab_conversations WHERE idx = $1',
    [idx],
  );
  if (!rows[0]) {
    console.error('No seed data found. Run:  npm run seed');
    process.exit(1);
  }
  return rows[0].conversation_id;
}

async function main(): Promise<void> {
  await migrate();
  const arg = (process.argv[2] ?? '').toLowerCase();

  if (!arg) {
    console.log(MENU);
    return;
  }

  const stats = await tableStats();
  hr();
  console.log(`Dataset: ${stats.messages} messages, table ${stats.sizePretty}, indexes ${stats.indexSize}`);

  // Sparse conversation (few rows) makes scan-vs-index lessons honest: a Seq
  // Scan must wade through the whole table. Hot conversation (many rows) is
  // used for the deep-pagination lesson.
  const sparse = await getConvId(1);
  const hot = await getConvId(0);

  const runs: Record<string, () => Promise<void>> = {
    '1': () => exp1(sparse),
    '2': () => exp2(sparse),
    '3': () => exp3(sparse),
    '4': () => exp4(hot),
    '5': () => exp5(),
    '6': () => exp6(sparse),
  };

  if (arg === 'all') {
    for (const key of ['1', '2', '3', '4', '5', '6']) {
      await runs[key]!();
    }
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
