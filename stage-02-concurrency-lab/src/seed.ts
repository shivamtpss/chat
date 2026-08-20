import { ulid } from 'ulid';
import { pool, closePool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { config } from './lib/config.js';

/**
 * Seed messages so read queries have real data to touch. We keep one known
 * conversation id in a helper table so experiments can query it deterministically.
 */
async function main(): Promise<void> {
  await migrate();

  const total = Number(process.argv[2] ?? config.SEED_MESSAGES);
  const conversations = config.SEED_CONVERSATIONS;

  await pool.query('TRUNCATE messages');
  await pool.query('DROP TABLE IF EXISTS lab_conversations');
  await pool.query('CREATE TABLE lab_conversations (idx INT PRIMARY KEY, conversation_id TEXT NOT NULL)');

  const convIds: string[] = [];
  for (let i = 0; i < conversations; i++) convIds.push(ulid());
  {
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (let i = 0; i < convIds.length; i++) {
      values.push(`($${p++}, $${p++})`);
      params.push(i, convIds[i]);
    }
    await pool.query(`INSERT INTO lab_conversations(idx, conversation_id) VALUES ${values.join(',')}`, params);
  }

  console.log(`Seeding ${total} messages across ${conversations} conversations ...`);
  const batch = 2000;
  let made = 0;
  while (made < total) {
    const n = Math.min(batch, total - made);
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (let j = 0; j < n; j++) {
      const conv = convIds[Math.floor(Math.random() * conversations)]!;
      values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(ulid(), conv, ulid(), `msg ${made + j}`);
    }
    await pool.query(
      `INSERT INTO messages(id, conversation_id, sender_id, body) VALUES ${values.join(',')}`,
      params,
    );
    made += n;
    if ((made / batch) % 20 === 0) process.stdout.write('.');
  }

  await pool.query('ANALYZE messages');
  console.log(`\nDone. Seeded ${total} messages. Now run: npm run lab:all`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
