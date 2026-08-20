import { pool } from '../db/pool.js';

/** Fetch a known conversation id so read queries are deterministic. */
export async function getConvId(idx = 0): Promise<string> {
  const { rows } = await pool.query<{ conversation_id: string }>(
    'SELECT conversation_id FROM lab_conversations WHERE idx = $1',
    [idx],
  );
  if (!rows[0]) {
    console.error('No seed data found. Run:  npm run seed');
    process.exit(1);
  }
  return rows[0].conversation_id;
}
