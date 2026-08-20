import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * End-to-end smoke test with zero test framework: register two users, open a
 * 1:1 conversation, connect both over WebSocket, send a message from Alice,
 * and assert Bob receives it and Alice gets an ack. Also verifies idempotency
 * (same clientMsgId twice => one message) and history retrieval.
 *
 * Run against a running server (npm run dev in another terminal):
 *   npm run smoke
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';
const WS_BASE = BASE.replace('http', 'ws');

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/**
 * Wrap a socket with a message queue so we never miss an event due to a race
 * between connecting and attaching a listener (the server sends `ready`
 * immediately on connect).
 */
interface Client {
  ws: WebSocket;
  queue: any[];
  waiters: Array<{ type: string; resolve: (m: any) => void }>;
}

function open(token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    const client: Client = { ws, queue: [], waiters: [] };
    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      const idx = client.waiters.findIndex((w) => w.type === msg.type);
      if (idx >= 0) {
        const [w] = client.waiters.splice(idx, 1);
        w!.resolve(msg);
      } else {
        client.queue.push(msg);
      }
    });
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}

function next(client: Client, type: string, timeoutMs = 3000): Promise<any> {
  const idx = client.queue.findIndex((m) => m.type === type);
  if (idx >= 0) return Promise.resolve(client.queue.splice(idx, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    client.waiters.push({
      type,
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    });
  });
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  console.log('health...');
  const health = (await fetch(`${BASE}/health`).then((r) => r.json())) as { status: string };
  assert(health.status === 'ok', 'health ok');

  console.log('register users...');
  const alice = await post('/register', { username: 'alice', displayName: 'Alice' });
  const bob = await post('/register', { username: 'bob', displayName: 'Bob' });

  console.log('create direct conversation...');
  const { conversationId } = await post('/conversations/direct', {
    userA: alice.user.id,
    userB: bob.user.id,
  });

  console.log('connect sockets...');
  const aliceWs = await open(alice.token);
  const bobWs = await open(bob.token);
  await next(aliceWs, 'ready');
  await next(bobWs, 'ready');

  console.log('alice sends, bob should receive...');
  const clientMsgId = 'msg-1';
  const ackP = next(aliceWs, 'ack');
  const recvP = next(bobWs, 'message');
  aliceWs.ws.send(JSON.stringify({ type: 'send', conversationId, clientMsgId, body: 'hello bob' }));
  const ack = await ackP;
  const recv = await recvP;
  assert(ack.clientMsgId === clientMsgId, 'ack has clientMsgId');
  assert(recv.message.body === 'hello bob', 'bob got the body');
  assert(recv.message.senderId === alice.user.id, 'sender is alice');

  console.log('idempotency: resend same clientMsgId...');
  const ack2P = next(aliceWs, 'ack');
  aliceWs.ws.send(JSON.stringify({ type: 'send', conversationId, clientMsgId, body: 'hello bob' }));
  const ack2 = await ack2P;
  assert(ack2.deduped === true, 'second send is deduped');
  assert(ack2.messageId === ack.messageId, 'same message id on retry');

  console.log('authorization: stranger cannot post...');
  const carol = await post('/register', { username: 'carol', displayName: 'Carol' });
  const carolWs = await open(carol.token);
  await next(carolWs, 'ready');
  const errP = next(carolWs, 'error');
  carolWs.ws.send(JSON.stringify({ type: 'send', conversationId, clientMsgId: 'x', body: 'intrude' }));
  const err = await errP;
  assert(err.code === 'forbidden', 'non-member is forbidden');

  console.log('history: alice fetches...');
  const histP = next(aliceWs, 'history');
  aliceWs.ws.send(JSON.stringify({ type: 'history', conversationId, limit: 50 }));
  const hist = await histP;
  assert(hist.messages.length === 1, 'exactly one message in history (dedup worked)');

  aliceWs.ws.close();
  bobWs.ws.close();
  carolWs.ws.close();
  await delay(100);
  console.log('\nALL SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exit(1);
});
