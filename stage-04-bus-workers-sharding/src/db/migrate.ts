import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.js';
import { config } from '../lib/config.js';
import { makeLogger } from '../lib/logger.js';

const logger = makeLogger('migrate');
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', '..', 'migrations');
const MIGRATION_LOCK_KEY = 424204;

/** Create the N hash partitions for the messages table (idempotent). */
async function ensurePartitions(client: import('pg').PoolClient, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await client.query(
      `CREATE TABLE IF NOT EXISTS messages_p${i}
       PARTITION OF messages FOR VALUES WITH (MODULUS ${n}, REMAINDER ${i})`,
    );
  }
}

export async function migrate(): Promise<void> {
  // Advisory lock so multiple gateways/workers booting at once do not race on
  // DDL (learned the hard way in Stage 03).
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await lockClient.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    const { rows } = await lockClient.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      try {
        await lockClient.query('BEGIN');
        await lockClient.query(sql);
        await lockClient.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await lockClient.query('COMMIT');
        logger.info({ file }, 'migration applied');
      } catch (err) {
        await lockClient.query('ROLLBACK');
        throw err;
      }
    }

    // Partitions are config-driven (MESSAGE_PARTITIONS), so create them here
    // rather than in a static .sql file. Idempotent, runs every boot.
    await ensurePartitions(lockClient, config.MESSAGE_PARTITIONS);
    logger.info({ partitions: config.MESSAGE_PARTITIONS }, 'message partitions ensured');
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    lockClient.release();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => logger.info('migrations complete'))
    .catch((err) => {
      logger.error({ err }, 'migration run failed');
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
