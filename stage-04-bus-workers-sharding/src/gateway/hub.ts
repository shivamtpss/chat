import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { config } from '../lib/config.js';
import { makeLogger } from '../lib/logger.js';
import { verifyToken } from '../lib/auth.js';
import { clientMessage, type ServerMessage, type BusJob } from '../bus/protocol.js';
import { publish } from '../bus/bus.js';
import { registerPresence, clearPresence } from '../bus/routing.js';
import { getMessagesPage, isMember } from '../db/repo.js';

const logger = makeLogger(`gateway:${config.SERVER_ID}`);

interface ConnState {
  userId: string;
  isAlive: boolean;
}

/** Sockets held by THIS gateway, keyed by user id (multi-device -> set). */
const byUser = new Map<string, Set<WebSocket>>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

/** Push a message to a locally-connected user (called when our channel fires). */
export function deliverLocal(userId: string, msg: ServerMessage): void {
  const set = byUser.get(userId);
  if (!set) return;
  const payload = JSON.stringify(msg);
  for (const ws of set) if (ws.readyState === 1) ws.send(payload);
}

export function localUserIds(): IterableIterator<string> {
  return byUser.keys();
}

export function attachConnectionHandlers(wss: import('ws').WebSocketServer): void {
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const st = (ws as WebSocket & { _state?: ConnState })._state;
      if (!st) continue;
      if (!st.isAlive) {
        ws.terminate();
        continue;
      }
      st.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const token = url.searchParams.get('token') ?? '';
    const userId = verifyToken(token);
    if (!userId) {
      send(ws, { type: 'error', code: 'unauthorized', message: 'invalid token' });
      ws.close(1008, 'unauthorized');
      return;
    }

    const state: ConnState = { userId, isAlive: true };
    (ws as WebSocket & { _state?: ConnState })._state = state;
    let set = byUser.get(userId);
    if (!set) {
      set = new Set();
      byUser.set(userId, set);
    }
    set.add(ws);
    void registerPresence(userId, config.SERVER_ID);
    send(ws, { type: 'ready', userId, server: config.SERVER_ID });

    ws.on('pong', () => {
      state.isAlive = true;
    });
    ws.on('message', (raw) => void handle(ws, state, raw.toString()));
    ws.on('close', () => {
      const s = byUser.get(userId);
      if (s) {
        s.delete(ws);
        if (s.size === 0) {
          byUser.delete(userId);
          void clearPresence(userId, config.SERVER_ID);
        }
      }
    });
    ws.on('error', (err) => logger.warn({ userId, err }, 'ws error'));
  });
}

async function handle(ws: WebSocket, state: ConnState, raw: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    send(ws, { type: 'error', code: 'bad_json', message: 'invalid JSON' });
    return;
  }
  const result = clientMessage.safeParse(parsed);
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
        // Authorize at the edge (cheap, protects the bus from junk).
        if (!(await isMember(msg.conversationId, state.userId))) {
          send(ws, { type: 'error', code: 'forbidden', message: 'not a member' });
          return;
        }
        // The gateway does NOT persist or fan out. It just drops the job on the
        // durable bus and moves on. This keeps the hot path tiny and means a
        // burst is absorbed by the log instead of overwhelming the database.
        const job: BusJob = {
          conversationId: msg.conversationId,
          senderId: state.userId,
          clientMsgId: msg.clientMsgId,
          body: msg.body,
          originServer: config.SERVER_ID,
        };
        await publish(job as unknown as Record<string, string>);
        // Tell the sender we accepted it (queued durably on the bus). The
        // stronger "ack" (persisted to Postgres) comes back from a worker.
        send(ws, { type: 'accepted', clientMsgId: msg.clientMsgId });
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
            seq: r.seq,
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
    logger.error({ err, type: msg.type }, 'handler failed');
    send(ws, { type: 'error', code: 'internal', message: 'internal error' });
  }
}
