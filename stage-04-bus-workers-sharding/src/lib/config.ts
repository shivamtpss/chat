import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().startsWith('postgres'),
  REDIS_URL: z.string().startsWith('redis'),
  SERVER_ID: z.string().min(1).default('A'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  WORKER_ID: z.string().min(1).default('w1'),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  AUTH_SECRET: z.string().min(8),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  BUS_STREAM: z.string().min(1).default('chat:messages'),
  BUS_GROUP: z.string().min(1).default('persist-workers'),
  MESSAGE_PARTITIONS: z.coerce.number().int().min(1).max(64).default(8),
  PRESENCE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  PRESENCE_HEARTBEAT_MS: z.coerce.number().int().positive().default(10_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:\n', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
