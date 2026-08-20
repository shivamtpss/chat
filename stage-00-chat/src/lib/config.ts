import 'dotenv/config';
import { z } from 'zod';

/**
 * Centralized, validated config. We fail fast at boot if the environment is
 * misconfigured rather than crashing mysteriously later. This is a small but
 * real best practice.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().url().or(z.string().startsWith('postgres')),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  PG_POOL_IDLE_MS: z.coerce.number().int().nonnegative().default(30_000),
  PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(5_000),
  AUTH_SECRET: z.string().min(8, 'AUTH_SECRET must be at least 8 chars'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WS_HEARTBEAT_MS: z.coerce.number().int().positive().default(30_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
