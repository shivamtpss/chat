import { pool, closePool } from '../src/db/pool.js';

/**
 * Demonstrates the pagination lesson you asked about.
 *
 * Your intuition: "we only show 50 messages (LIMIT 50), so how can it be slow?"
 * The catch: HOW you ask for "the next page" matters far more than the LIMIT.
 *
 *   - OFFSET pagination ("skip 25000, take 50") makes Postgres walk and throw
 *     away those 25000 rows every single time. Deep pages get slower and slower.
 *   - KEYSET/cursor pagination ("take 50 where id < last_seen_id") jumps
 *     straight to the spot using the index. Page 1 and page 5000 cost the same.
 *
 * Both return 50 rows. Only one stays fast. Run:
 *   npm run bench:pagination -- <conversationId>
 */
async function timeIt(label: string, fn: () => Promise<number>): Promise<void> {
  // warm up
  await fn();
  const runs = 5;
  let total = 0;
  let rows = 0;
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    rows = await fn();
    total += Number(process.hrtime.bigint() - start) / 1e6;
  }
  console.log(`${label.padEnd(42)} avg ${(total / runs).toFixed(2)} ms  (${rows} rows)`);
}

async function main(): Promise<void> {
  const convId = process.argv[2];
  if (!convId) {
    console.error('Usage: npm run bench:pagination -- <conversationId>');
    console.error('Get a conversationId by running: npm run seed -- 200000');
    process.exitCode = 1;
    return;
  }

  const { rows: cnt } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM messages WHERE conversation_id = $1',
    [convId],
  );
  const total = Number(cnt[0]?.n ?? 0);
  console.log(`Conversation ${convId} has ${total} messages.\n`);

  const pageSize = 50;
  const deepOffset = Math.max(0, total - pageSize - 100); // near the far end

  console.log('--- OFFSET pagination (the trap) ---');
  await timeIt('OFFSET 0 (first page)', async () => {
    const r = await pool.query(
      `SELECT id, body FROM messages WHERE conversation_id = $1
       ORDER BY id DESC OFFSET 0 LIMIT $2`,
      [convId, pageSize],
    );
    return r.rowCount ?? 0;
  });
  await timeIt(`OFFSET ${deepOffset} (deep page)`, async () => {
    const r = await pool.query(
      `SELECT id, body FROM messages WHERE conversation_id = $1
       ORDER BY id DESC OFFSET $2 LIMIT $3`,
      [convId, deepOffset, pageSize],
    );
    return r.rowCount ?? 0;
  });

  // Get a cursor near the far end for a fair keyset comparison.
  const cursorRow = await pool.query<{ id: string }>(
    `SELECT id FROM messages WHERE conversation_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1`,
    [convId, deepOffset],
  );
  const cursor = cursorRow.rows[0]?.id;

  console.log('\n--- KEYSET / cursor pagination (the fix) ---');
  await timeIt('KEYSET first page (no cursor)', async () => {
    const r = await pool.query(
      `SELECT id, body FROM messages WHERE conversation_id = $1
       ORDER BY id DESC LIMIT $2`,
      [convId, pageSize],
    );
    return r.rowCount ?? 0;
  });
  if (cursor) {
    await timeIt('KEYSET deep page (id < cursor)', async () => {
      const r = await pool.query(
        `SELECT id, body FROM messages WHERE conversation_id = $1 AND id < $2
         ORDER BY id DESC LIMIT $3`,
        [convId, cursor, pageSize],
      );
      return r.rowCount ?? 0;
    });
  }

  console.log('\nTakeaway: OFFSET gets slower the deeper you scroll; KEYSET stays flat.');
  console.log('That is why Stage 00 uses id < cursor, not OFFSET. LIMIT alone does NOT save you.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
