import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { issueToken } from '../lib/auth.js';
import { pool } from '../db/pool.js';
import { redis } from '../db/redis.js';
import { getOrCreateDirectConversation, upsertUser } from '../db/repo.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const registerSchema = z.object({
  username: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_]+$/),
  displayName: z.string().min(1).max(64),
});
const directSchema = z.object({ userA: z.string().min(1), userB: z.string().min(1) });

export function createHttpServer() {
  return createServer((req, res) => {
    void route(req, res).catch((err) => {
      logger.error({ err }, 'http handler error');
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    try {
      await pool.query('SELECT 1');
      await redis.ping();
      json(res, 200, { status: 'ok', server: config.SERVER_ID });
    } catch {
      json(res, 503, { status: 'dependency_unavailable', server: config.SERVER_ID });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/register') {
    const parsed = registerSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: 'bad_request' });
    const user = await upsertUser(parsed.data.username, parsed.data.displayName);
    return json(res, 200, { user, token: issueToken(user.id) });
  }

  if (req.method === 'POST' && url.pathname === '/conversations/direct') {
    const parsed = directSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: 'bad_request' });
    const id = await getOrCreateDirectConversation(parsed.data.userA, parsed.data.userB);
    return json(res, 200, { conversationId: id });
  }

  json(res, 404, { error: 'not_found' });
}
