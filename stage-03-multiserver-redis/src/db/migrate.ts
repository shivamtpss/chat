import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.js';
import { logger } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', '..', 'migrations');

export async function migrate(): Promise<void> {
  // Multiple gateway instances boot at once and all call migrate(). Without
  // coordination they race on CREATE TABLE and one crashes. A Postgres advisory
  // lock serializes them: the first server migrates, the others WAIT here and
  // then find everything already applied. This is the correct multi-instance
  // pattern (real projects often run migrations as a separate deploy step, but
  // an advisory lock makes boot-time migration safe too).
  const MIGRATION_LOCK_KEY = 424203; // arbitrary constant shared by all instances
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
