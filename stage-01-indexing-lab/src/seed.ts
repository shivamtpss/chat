import { ulid } from 'ulid';
import { pool, closePool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { config } from './lib/config.js';

/**
 * Seed a large, realistic-ish dataset: many conversations, each with many
 * messages, spread over time. We store the generated conversation ids in a
 * small table so the lab can pick a "hot" conversation deterministically.
 *
 * Usage:
 *   npm run seed              # uses SEED_MESSAGES from .env (default 300k)
 *   npm run seed -- 500000    # override count
 */
async function main(): Promise<void> {
  await migrate();

  const totalMessages = Number(process.argv[2] ?? config.SEED_MESSAGES);
  const conversations = config.SEED_CONVERSATIONS;

  // Reset data so re-seeding is clean and repeatable.
  await pool.query('TRUNCATE messages, users RESTART IDENTITY');
  await pool.query('DROP TABLE IF EXISTS lab_conversations');
  await pool.query('CREATE TABLE lab_conversations (idx INT PRIMARY KEY, conversation_id TEXT NOT NULL)');

  // A pool of users and conversation ids.
  const userIds: string[] = [];
  for (let i = 0; i < 200; i++) userIds.push(ulid());
  {
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (const uid of userIds) {
      values.push(`($${p++}, $${p++}, $${p++})`);
      params.push(uid, `user_${uid.slice(-6)}`, `User ${uid.slice(-4)}`);
    }
    await pool.query(`INSERT INTO users(id, username, display_name) VALUES ${values.join(',')}`, params);
  }

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

  console.log(
    `Seeding ${totalMessages} messages across ${conversations} conversations ...`,
  );

  const batch = 2000;
  let made = 0;
  while (made < totalMessages) {
    const n = Math.min(batch, totalMessages - made);
    const values: string[] = [];
    const params: unknown[] = [];
    let p = 1;
    for (let j = 0; j < n; j++) {
      // Skew so conversation 0 is a "hot" conversation with lots of messages.
      const convIdx = Math.random() < 0.25 ? 0 : Math.floor(Math.random() * conversations);
      const conv = convIds[convIdx]!;
      const sender = userIds[Math.floor(Math.random() * userIds.length)]!;
      values.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      params.push(ulid(), conv, sender, `msg ${made + j} in conv ${convIdx}`);
    }
    await pool.query(
      `INSERT INTO messages(id, conversation_id, sender_id, body) VALUES ${values.join(',')}`,
      params,
    );
    made += n;
    if ((made / batch) % 25 === 0) process.stdout.write('.');
  }

  await pool.query('ANALYZE messages'); // make planner stats accurate
  const { rows } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM messages WHERE conversation_id = $1',
    [convIds[0]],
  );
  const { rows: sparse } = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM messages WHERE conversation_id = $1',
    [convIds[1]],
  );
  console.log(`\nDone.`);
  console.log(`  Hot conversation  (idx 0) ${convIds[0]} has ${rows[0]?.n} messages (deep pagination demo).`);
  console.log(`  Sparse conversation (idx 1) ${convIds[1]} has ${sparse[0]?.n} messages (scan-vs-index demo).`);
  console.log('Now run: npm run lab:all');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
