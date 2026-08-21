import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/**
 * Same tiny signed-token scheme as Stage 00 (`${userId}.${hmac}`). Crucially,
 * because every server shares the same AUTH_SECRET, a token minted by server A
 * is accepted by server B. That is what lets a load balancer send a user to
 * ANY server: identity is verified from the token, not from server-local state.
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
