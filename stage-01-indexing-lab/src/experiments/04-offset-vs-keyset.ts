import { timeQuery, explain, printPlan, createIndex, dropIndex, hr } from '../lib/explain.js';
import { query } from '../db/pool.js';

/**
 * EXPERIMENT 4: OFFSET vs keyset, even WITH an index.
 *
 * This is the follow-up to the Stage 00 question "we paginate, so why slow?".
 * Even with the right index, OFFSET still makes Postgres walk and discard all
 * the skipped rows. Keyset (WHERE id < cursor) does not. Both return 50 rows.
 */
export async function run(hotConvId: string): Promise<void> {
  hr();
  console.log('EXPERIMENT 4: OFFSET vs keyset pagination (with an index present)');
  console.log('Lesson: LIMIT caps output, not work. OFFSET still scans+discards skipped rows.');
  hr();

  // Ensure the index exists so this is a fair "even with an index" test.
  await dropIndex('ix_lab_conv_id');
  await createIndex('CREATE INDEX ix_lab_conv_id ON messages (conversation_id, id DESC)');

  const { rows } = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM messages WHERE conversation_id = $1',
    [hotConvId],
  );
  const total = Number(rows[0]?.n ?? 0);
  const deep = Math.max(0, total - 100);
  console.log(`\n  Hot conversation has ${total} messages. Deep page offset = ${deep}.`);

  const first = await timeQuery(
    `SELECT id, body FROM messages WHERE conversation_id = $1 ORDER BY id DESC OFFSET 0 LIMIT 50`,
    [hotConvId],
  );
  const offsetDeep = await timeQuery(
    `SELECT id, body FROM messages WHERE conversation_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 50`,
    [hotConvId, deep],
  );

  // Get a cursor near the deep end for the keyset comparison.
  const cursorRow = await query<{ id: string }>(
    `SELECT id FROM messages WHERE conversation_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 1`,
    [hotConvId, deep],
  );
  const cursor = cursorRow.rows[0]?.id ?? '';
  const keysetDeep = await timeQuery(
    `SELECT id, body FROM messages WHERE conversation_id = $1 AND id < $2 ORDER BY id DESC LIMIT 50`,
    [hotConvId, cursor],
  );

  console.log('\n  Median timings (all return 50 rows):');
  console.log(`    OFFSET 0      (first page)  ${first.medianMs.toFixed(2)} ms`);
  console.log(`    OFFSET ${deep} (deep page)   ${offsetDeep.medianMs.toFixed(2)} ms`);
  console.log(`    KEYSET id<cursor (deep page) ${keysetDeep.medianMs.toFixed(2)} ms`);

  console.log('\n  Plans for the deep page:');
  const offPlan = await explain(
    `SELECT id, body FROM messages WHERE conversation_id = $1 ORDER BY id DESC OFFSET $2 LIMIT 50`,
    [hotConvId, deep],
  );
  printPlan('OFFSET deep page', offPlan);
  const keyPlan = await explain(
    `SELECT id, body FROM messages WHERE conversation_id = $1 AND id < $2 ORDER BY id DESC LIMIT 50`,
    [hotConvId, cursor],
  );
  printPlan('KEYSET deep page', keyPlan);

  console.log('\n  Takeaway: keyset stays flat no matter how deep you scroll. This is why');
  console.log('  Stage 00 paginates with id < cursor, not OFFSET/page numbers.');
}
