import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from './pool.js';
import { logger } from '../lib/logger.js';

/**
 * Minimal forward-only migration runner. Applies any *.sql file in
 * ../../migrations that has not been applied yet, in filename order, and
 * records it in a schema_migrations table. Idempotent: safe to run repeatedly.
 *
 * A real project would use a library (node-pg-migrate, Flyway, etc.); this
 * hand-rolled version keeps Stage 00 dependency-light while still being safe.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', '..', 'migrations');

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedMigrations(): Promise<Set<string>> {
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
}

export async function migrate(): Promise<void> {
  await ensureMigrationsTable();
  const applied = await appliedMigrations();
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) {
      logger.info({ file }, 'migration already applied, skipping');
      continue;
    }
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info({ file }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ file, err }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }
}

// Allow running directly: `npm run db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => logger.info('migrations complete'))
    .catch((err) => {
      logger.error({ err }, 'migration run failed');
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
