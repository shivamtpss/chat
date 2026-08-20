import 'dotenv/config';

/**
 * Tiny config. The lab is intentionally low-ceremony; we only need a DB URL and
 * a couple of seed knobs.
 */
function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}. Did you copy .env.example to .env?`);
    process.exit(1);
  }
  return v;
}

export const config = {
  DATABASE_URL: required('DATABASE_URL'),
  PG_POOL_MAX: Number(process.env.PG_POOL_MAX ?? 10),
  SEED_MESSAGES: Number(process.env.SEED_MESSAGES ?? 300_000),
  SEED_CONVERSATIONS: Number(process.env.SEED_CONVERSATIONS ?? 2_000),
};
