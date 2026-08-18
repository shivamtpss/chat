import pg from 'pg';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

const { Pool } = pg;

/**
 * A single shared connection pool for the whole process.
 *
 * Why a pool even at Stage 00: opening a Postgres connection is expensive and
 * Postgres itself only tolerates a limited number of them. We borrow-and-return
 * a small, fixed set. This is the exact mechanism that lets us serve many users
 * later (see Stage 02); we simply establish the habit now.
 */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  idleTimeoutMillis: config.PG_POOL_IDLE_MS,
  // Safety net: no single query is allowed to hang forever and hog a
  // connection. A slow query starving the pool is a classic outage cause.
  statement_timeout: config.PG_STATEMENT_TIMEOUT_MS,
});

pool.on('error', (err) => {
  // Errors on idle clients should be logged, not crash the process.
  logger.error({ err }, 'idle postgres client error');
});

/** Thin typed query helper so call sites stay clean. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const started = Date.now();
  try {
    return await pool.query<T>(text, params as unknown[]);
  } finally {
    const ms = Date.now() - started;
    if (ms > 200) logger.warn({ ms, text }, 'slow query'); // early smell of a missing index
  }
}

/**
 * Run a set of statements inside a transaction. Used where several writes must
 * all succeed or all fail together (e.g. create conversation + add members).
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
