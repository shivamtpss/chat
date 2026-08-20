import { query } from '../db/pool.js';

/**
 * The lab's teaching helpers. These wrap EXPLAIN ANALYZE and timing so each
 * experiment reads like a story: "here is the query, here is what Postgres
 * decided to do, here is how long it took."
 */

export interface ExplainResult {
  planLines: string[];
  scanKind: string; // e.g. "Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Heap Scan"
  usedIndex: string | null;
  executionMs: number | null;
  planningMs: number | null;
  rows: number | null;
}

/** Run EXPLAIN (ANALYZE, BUFFERS) and parse the interesting bits out. */
export async function explain(sql: string, params: readonly unknown[] = []): Promise<ExplainResult> {
  const { rows } = await query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS, SUMMARY) ${sql}`,
    params,
  );
  const planLines = rows.map((r) => r['QUERY PLAN']);
  const text = planLines.join('\n');

  const scanKinds = [
    'Index Only Scan',
    'Index Scan',
    'Bitmap Heap Scan',
    'Bitmap Index Scan',
    'Seq Scan',
  ];
  const scanKind = scanKinds.find((k) => text.includes(k)) ?? 'unknown';

  const idxMatch = text.match(/using (\w+)/);
  const usedIndex = idxMatch ? idxMatch[1]! : null;

  const execMatch = text.match(/Execution Time: ([\d.]+) ms/);
  const planMatch = text.match(/Planning Time: ([\d.]+) ms/);
  const rowsMatch = text.match(/rows=(\d+)/);

  return {
    planLines,
    scanKind,
    usedIndex,
    executionMs: execMatch ? Number(execMatch[1]) : null,
    planningMs: planMatch ? Number(planMatch[1]) : null,
    rows: rowsMatch ? Number(rowsMatch[1]) : null,
  };
}

/** Time a query by actually running it N times (median), separate from EXPLAIN. */
export async function timeQuery(
  sql: string,
  params: readonly unknown[] = [],
  runs = 5,
): Promise<{ medianMs: number; rows: number }> {
  await query(sql, params); // warm up
  const samples: number[] = [];
  let rowCount = 0;
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    const r = await query(sql, params);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
    rowCount = r.rowCount ?? 0;
  }
  samples.sort((a, b) => a - b);
  const mid = Math.floor(samples.length / 2);
  const median =
    samples.length % 2 ? samples[mid]! : (samples[mid - 1]! + samples[mid]!) / 2;
  return { medianMs: median, rows: rowCount };
}

export async function createIndex(ddl: string): Promise<number> {
  const start = process.hrtime.bigint();
  await query(ddl);
  await query('ANALYZE messages'); // refresh planner stats so it uses the new index
  return Number(process.hrtime.bigint() - start) / 1e6;
}

export async function dropIndex(name: string): Promise<void> {
  await query(`DROP INDEX IF EXISTS ${name}`);
  await query('ANALYZE messages');
}

export async function indexExists(name: string): Promise<boolean> {
  const { rows } = await query<{ one: number }>(
    `SELECT 1 AS one FROM pg_indexes WHERE indexname = $1`,
    [name],
  );
  return rows.length > 0;
}

export async function tableStats(): Promise<{ messages: number; sizePretty: string; indexSize: string }> {
  const { rows } = await query<{ n: string }>('SELECT count(*)::text AS n FROM messages');
  const size = await query<{ t: string; i: string }>(
    `SELECT pg_size_pretty(pg_table_size('messages')) AS t,
            pg_size_pretty(pg_indexes_size('messages')) AS i`,
  );
  return {
    messages: Number(rows[0]?.n ?? 0),
    sizePretty: size.rows[0]?.t ?? '?',
    indexSize: size.rows[0]?.i ?? '?',
  };
}

// ---- pretty printing ----

export function hr(): void {
  console.log('-'.repeat(72));
}

export function printPlan(label: string, r: ExplainResult): void {
  const idx = r.usedIndex ? ` using ${r.usedIndex}` : '';
  console.log(`\n[${label}]`);
  console.log(`  scan: ${r.scanKind}${idx}`);
  console.log(`  planner exec time: ${r.executionMs ?? '?'} ms`);
  console.log('  plan:');
  for (const line of r.planLines) console.log(`    ${line}`);
}

export function verdict(before: ExplainResult, after: ExplainResult): void {
  const b = before.executionMs ?? 0;
  const a = after.executionMs ?? 0;
  if (a > 0 && b > 0) {
    const factor = (b / a).toFixed(1);
    console.log(`\n  => ${before.scanKind} ${b} ms  vs  ${after.scanKind} ${a} ms  (~${factor}x faster)`);
  }
}
