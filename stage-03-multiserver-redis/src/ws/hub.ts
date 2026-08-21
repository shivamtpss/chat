import type { IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { verifyToken } from '../lib/auth.js';
import { clientMessage, type ServerMessage } from './protocol.js';
import { local } from './registry.js';
import { registerPresence, clearPresence, routeToUser } from './routing.js';
import { getMessagesPage, insertMessage, isMember, memberIdsExcept } from '../db/repo.js';

interface ConnState {
  userId: string;
  isAlive: boolean;
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function attachWebSocketServer(wss: WebSocketServer): void {
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
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const userId = verifyToken(token);
    if (!userId) {
      send(ws, { type: 'error', code: 'unauthorized', message: 'invalid or missing token' });
      ws.close(1008, 'unauthorized');
      return;
    }

    const state: ConnState = { userId, isAlive: true };
    (ws as WebSocket & { _state?: ConnState })._state = state;
    local.add(userId, ws);
    void registerPresence(userId);
    send(ws, { type: 'ready', userId, server: config.SERVER_ID });
    logger.info({ userId, localUsers: local.localUserCount() }, 'ws connected');

    ws.on('pong', () => {
      state.isAlive = true;
    });

    ws.on('message', (raw) => {
      void handleMessage(ws, state, raw.toString());
    });

    ws.on('close', () => {
      const wasLast = local.remove(userId, ws);
      if (wasLast) void clearPresence(userId);
      logger.info({ userId, wasLast }, 'ws disconnected');
    });

    ws.on('error', (err) => logger.warn({ userId, err }, 'ws error'));
  });
}

async function handleMessage(ws: WebSocket, state: ConnState, raw: string): Promise<void> {
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

        // Ack the sender AFTER durable persist (no message loss guarantee).
        send(ws, {
          type: 'ack',
          clientMsgId: msg.clientMsgId,
          messageId: message.id,
          createdAt: message.created_at,
          deduped,
        });

        if (deduped) return;

        // Deliver to every other member, wherever they are connected. This is
        // the Stage 03 magic: recipients on OTHER servers are reached via Redis.
        const recipients = await memberIdsExcept(msg.conversationId, state.userId);
        await Promise.all(
          recipients.map((rid) =>
            routeToUser({
              targetUserId: rid,
              fromServer: config.SERVER_ID,
              message: {
                id: message.id,
                conversationId: message.conversation_id,
                senderId: message.sender_id,
                body: message.body,
                createdAt: message.created_at,
              },
            }),
          ),
        );
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
        const _never: never = msg;
        void _never;
      }
    }
  } catch (err) {
    logger.error({ err, userId: state.userId, type: msg.type }, 'message handler failed');
    send(ws, { type: 'error', code: 'internal', message: 'internal error' });
  }
}
