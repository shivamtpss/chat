import pg from 'pg';
import { config } from '../lib/config.js';

const { Pool } = pg;

export interface PoolOptions {
  max: number;
  /** ms a caller waits for a free connection before giving up (0 = wait forever). */
  connectionTimeoutMillis?: number;
  /** ms a single statement may run before Postgres cancels it (0 = no limit). */
  statementTimeoutMillis?: number;
}

/**
 * Build a fresh pool with a chosen size. The whole point of this lab is to see
 * how behavior changes as the pool size and timeouts change, so we make pools
 * on demand instead of having one global pool.
 */
export function makePool(opts: PoolOptions): pg.Pool {
  const poolConfig: pg.PoolConfig = {
    connectionString: config.DATABASE_URL,
    max: opts.max,
  };
  if (opts.connectionTimeoutMillis !== undefined) {
    poolConfig.connectionTimeoutMillis = opts.connectionTimeoutMillis;
  }
  if (opts.statementTimeoutMillis !== undefined) {
    poolConfig.statement_timeout = opts.statementTimeoutMillis;
  }
  const pool = new Pool(poolConfig);
  pool.on('error', () => {
    /* swallow idle-client errors during teardown */
  });
  return pool;
}

/** A default pool for migrations/seed. */
export const pool = makePool({ max: config.PG_POOL_MAX });

export async function closePool(): Promise<void> {
  await pool.end();
}
