import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/** Same shared-secret token scheme as Stage 00/03; works across all gateways. */
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
  const a = Buffer.from(providedSig);
  const b = Buffer.from(sign(userId));
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? userId : null;
}
