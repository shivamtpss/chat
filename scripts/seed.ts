import { ulid } from 'ulid';
import { pool, closePool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

/**
 * Seed a lot of messages into one conversation so we can FEEL the pagination
 * difference. Usage:
 *   npm run seed -- 200000     # inserts ~200k messages into a demo conversation
 *
 * It prints the conversation id you can use with the pagination benchmark.
 */
async function main(): Promise<void> {
  await migrate();

  const count = Number(process.argv[2] ?? 200_000);
  const userId = ulid();
  const convId = ulid();

  await pool.query(`INSERT INTO users(id, username, display_name) VALUES ($1,$2,$3)
                    ON CONFLICT (username) DO NOTHING`,
    [userId, `bench_${userId.slice(-6)}`, 'Bench User']);
  await pool.query(`INSERT INTO conversations(id, type) VALUES ($1,'group')`, [convId]);
  await pool.query(`INSERT INTO conversation_members(conversation_id, user_id) VALUES ($1,$2)`,
    [convId, userId]);

  console.log(`Seeding ${count} messages into conversation ${convId} ...`);
  const batch = 1000;
  for (let i = 0; i < count; i += batch) {
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    const n = Math.min(batch, count - i);
    for (let j = 0; j < n; j++) {
      values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(ulid(), convId, userId, ulid(), `message #${i + j}`);
    }
    await pool.query(
      `INSERT INTO messages(id, conversation_id, sender_id, client_msg_id, body)
       VALUES ${values.join(',')}`,
      params,
    );
    if ((i / batch) % 20 === 0) process.stdout.write('.');
  }
  console.log(`\nDone. Conversation id: ${convId}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
