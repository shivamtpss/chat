import { explain, printPlan, createIndex, dropIndex, hr } from '../lib/explain.js';

/**
 * EXPERIMENT 2: Composite index column ORDER matters.
 *
 * An index on (conversation_id, id) is like a phone book sorted by last name
 * then first name. It is great for "filter by conversation_id" but useless for
 * a query that only filters by the SECOND column. We prove it.
 */
export async function run(hotConvId: string): Promise<void> {
  hr();
  console.log('EXPERIMENT 2: Composite index column order');
  console.log('Lesson: put the column you filter by (equality) FIRST.');
  hr();

  // Clean slate.
  await dropIndex('ix_lab_conv_id');
  await dropIndex('ix_lab_id_only');

  // Index with conversation_id first.
  await createIndex('CREATE INDEX ix_lab_conv_id ON messages (conversation_id, id DESC)');

  const convQuery = `SELECT id, body FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 50`;
  const good = await explain(convQuery, [hotConvId]);
  printPlan('Filter by conversation_id (first column) -> index used', good);

  // Now a query that filters only by sender_id, which is NOT in this index.
  const senderQuery = `SELECT id, body FROM messages WHERE sender_id = $1 LIMIT 50`;
  const someSender = await pickAnySender();
  const bad = await explain(senderQuery, [someSender]);
  printPlan('Filter by sender_id (not in the index) -> Seq Scan again', bad);

  console.log('\n  Takeaway: (conversation_id, id) does NOT help a sender_id-only filter.');
  console.log('  An index only helps queries whose leading column(s) it covers.');
  console.log('  If you frequently query by sender_id, that needs its OWN index.');
}

async function pickAnySender(): Promise<string> {
  const { query } = await import('../db/pool.js');
  const { rows } = await query<{ sender_id: string }>(
    'SELECT sender_id FROM messages LIMIT 1',
  );
  return rows[0]?.sender_id ?? '';
}
