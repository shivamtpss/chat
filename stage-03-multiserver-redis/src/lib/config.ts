import 'dotenv/config';
import { z } from 'zod';

/**
 * Validated config. Fail fast at boot on misconfiguration. SERVER_ID is new
 * and critical in Stage 03: every running instance must have a unique id so the
 * Redis routing directory can say "user X is on server A".
 */
const schema = z.object({
  DATABASE_URL: z.string().startsWith('postgres'),
  REDIS_URL: z.string().startsWith('redis'),
  SERVER_ID: z.string().min(1, 'SERVER_ID is required and must be unique per instance'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  AUTH_SECRET: z.string().min(8),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PRESENCE_HEARTBEAT_MS: z.coerce.number().int().positive().default(10_000),
  PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
