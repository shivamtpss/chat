import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { verifyToken } from '../lib/auth.js';
import { clientMessage, type ServerMessage } from './protocol.js';
import { connections } from './registry.js';
import {
  getMessagesPage,
  insertMessage,
  isMember,
  memberIdsExcept,
} from '../db/repo.js';

/**
 * A very small per-connection token-bucket rate limiter. Even at Stage 00,
 * one buggy or malicious client should not be able to flood the server. This
 * is a cheap safety habit that scales with us.
 */
class RateLimiter {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly capacity: number, private readonly refillPerSec: number) {
    this.tokens = capacity;
  }
  allow(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

interface ConnState {
  userId: string;
  isAlive: boolean;
  limiter: RateLimiter;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function attachWebSocketServer(wss: WebSocketServer): void {
  // Heartbeat: ping every WS_HEARTBEAT_MS; drop sockets that miss a pong.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const state = (ws as WebSocket & { _state?: ConnState })._state;
      if (!state) continue;
      if (!state.isAlive) {
        ws.terminate();
        continue;
      }
      state.isAlive = false;
      ws.ping();
    }
  }, config.WS_HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Authenticate at the handshake. Token is passed as ?token=... which is
    // fine for local dev; a real deploy uses a subprotocol header so tokens
    // are not logged in URLs (noted in the architecture docs).
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const userId = verifyToken(token);
    if (!userId) {
      send(ws, { type: 'error', code: 'unauthorized', message: 'invalid or missing token' });
      ws.close(1008, 'unauthorized');
      return;
    }

    const state: ConnState = { userId, isAlive: true, limiter: new RateLimiter(20, 10) };
    (ws as WebSocket & { _state?: ConnState })._state = state;
    connections.add(userId, ws);
    send(ws, { type: 'ready', userId });
    logger.info({ userId, online: connections.onlineCount() }, 'ws connected');

    ws.on('pong', () => {
      state.isAlive = true;
    });

    ws.on('message', (raw) => {
      void handleMessage(ws, state, raw.toString());
    });

    ws.on('close', () => {
      connections.remove(userId, ws);
      logger.info({ userId, online: connections.onlineCount() }, 'ws disconnected');
    });

    ws.on('error', (err) => {
      logger.warn({ userId, err }, 'ws error');
    });
  });
}

async function handleMessage(ws: WebSocket, state: ConnState, raw: string): Promise<void> {
  if (!state.limiter.allow()) {
    send(ws, { type: 'error', code: 'rate_limited', message: 'slow down' });
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    send(ws, { type: 'error', code: 'bad_json', message: 'invalid JSON' });
    return;
  }

  const result = clientMessage.safeParse(parsedJson);
  if (!result.success) {
    send(ws, { type: 'error', code: 'bad_request', message: 'schema validation failed' });
    return;
  }
  const msg = result.data;

  try {
    switch (msg.type) {
      case 'ping':
        send(ws, { type: 'pong' });
        return;

      case 'send': {
        // Authorize: the sender must be a member of the conversation.
        if (!(await isMember(msg.conversationId, state.userId))) {
          send(ws, { type: 'error', code: 'forbidden', message: 'not a member' });
          return;
        }

        const { message, deduped } = await insertMessage({
          conversationId: msg.conversationId,
          senderId: state.userId,
          clientMsgId: msg.clientMsgId,
          body: msg.body,
        });

        // Acknowledge to the sender (durable-persist happened before this ack).
        send(ws, {
          type: 'ack',
          clientMsgId: msg.clientMsgId,
          messageId: message.id,
          createdAt: message.created_at,
          deduped,
        });

        // Deliver to other members that are online on this server.
        if (!deduped) {
          const recipients = await memberIdsExcept(msg.conversationId, state.userId);
          const outbound: ServerMessage = {
            type: 'message',
            message: {
              id: message.id,
              conversationId: message.conversation_id,
              senderId: message.sender_id,
              body: message.body,
              createdAt: message.created_at,
            },
          };
          for (const rid of recipients) connections.deliver(rid, outbound);
        }
        return;
      }

      case 'history': {
        if (!(await isMember(msg.conversationId, state.userId))) {
          send(ws, { type: 'error', code: 'forbidden', message: 'not a member' });
          return;
        }
        const rows = await getMessagesPage({
          conversationId: msg.conversationId,
          limit: msg.limit,
          beforeId: msg.beforeId,
        });
        // rows are newest-first; the cursor for the next older page is the id
        // of the last (oldest) row we returned, or null if fewer than limit.
        const nextBeforeId = rows.length === msg.limit ? rows[rows.length - 1]!.id : null;
        send(ws, {
          type: 'history',
          conversationId: msg.conversationId,
          messages: rows.map((r) => ({
            id: r.id,
            senderId: r.sender_id,
            body: r.body,
            createdAt: r.created_at,
          })),
          nextBeforeId,
        });
        return;
      }

      default: {
        // Exhaustiveness guard: if a new message type is added and not handled,
        // TypeScript will flag this line at compile time.
        const _never: never = msg;
        void _never;
      }
    }
  } catch (err) {
    logger.error({ err, userId: state.userId, type: msg.type }, 'message handler failed');
    send(ws, { type: 'error', code: 'internal', message: 'internal error' });
  }
}
