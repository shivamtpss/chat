import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/**
 * Deliberately tiny token scheme for Stage 00: `${userId}.${hmac}`.
 *
 * This is NOT a full JWT and has no expiry; it is enough to demonstrate
 * authenticated connections and per-request authorization while keeping the
 * stage dependency-light. In the architecture docs (and by Stage 03) this is
 * replaced by short-lived signed JWTs from a real auth service. The important
 * habit we establish now: the server verifies identity on every connection and
 * authorizes every action, never trusting a client-supplied user id directly.
 */
function sign(userId: string): string {
  return createHmac('sha256', config.AUTH_SECRET).update(userId).digest('base64url');
}

export function issueToken(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

export function verifyToken(token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  const expectedSig = sign(userId);

  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? userId : null;
}
