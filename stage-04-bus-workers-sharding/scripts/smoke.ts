import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * End-to-end smoke test. Requires infra + at least one gateway + one worker:
 *   npm run infra:up
 *   npm run gateway:a     # terminal 1
 *   npm run worker:1      # terminal 2
 *   npm run smoke         # terminal 3
 *
 * Proves the full Stage 04 path: gateway accepts -> bus -> worker persists ->
 * worker delivers the durable ack to the sender and the message to the recipient.
 */
const BASE = process.env.BASE ?? 'http://localhost:3001';
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
      if (idx >= 0) client.waiters.splice(idx, 1)[0]!.resolve(msg);
      else client.queue.push(msg);
    });
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}
function next(client: Client, type: string, timeoutMs = 5000): Promise<any> {
  const idx = client.queue.findIndex((m) => m.type === type);
  if (idx >= 0) return Promise.resolve(client.queue.splice(idx, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    client.waiters.push({ type, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
}
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  console.log('health...');
  const h = (await fetch(`${BASE}/health`).then((r) => r.json())) as { status: string };
  assert(h.status === 'ok', 'gateway healthy');

  console.log('register alice + bob...');
  const alice = await post('/register', { username: 'alice', displayName: 'Alice' });
  const bob = await post('/register', { username: 'bob', displayName: 'Bob' });
  const { conversationId } = await post('/conversations/direct', {
    userA: alice.user.id,
    userB: bob.user.id,
  });

  const aliceWs = await open(alice.token);
  const bobWs = await open(bob.token);
  await next(aliceWs, 'ready');
  await next(bobWs, 'ready');
  await delay(150);

  console.log('alice sends...');
  const acceptedP = next(aliceWs, 'accepted');
  const ackP = next(aliceWs, 'ack');
  const recvP = next(bobWs, 'message');
  aliceWs.ws.send(JSON.stringify({ type: 'send', conversationId, clientMsgId: 'm1', body: 'hi via bus' }));

  const accepted = await acceptedP;
  assert(accepted.clientMsgId === 'm1', 'gateway accepted (queued to bus)');
  const ack = await ackP;
  assert(ack.messageId && ack.seq === '1', 'worker persisted with seq=1 and acked sender');
  const recv = await recvP;
  assert(recv.message.body === 'hi via bus', 'bob received the message');
  assert(recv.message.seq === '1', 'delivered message carries seq=1');
  console.log(`  accepted -> ack(seq=${ack.seq}) -> delivered. Bus path works.`);

  console.log('idempotency: resend same clientMsgId...');
  const ack2P = next(aliceWs, 'ack');
  aliceWs.ws.send(JSON.stringify({ type: 'send', conversationId, clientMsgId: 'm1', body: 'hi via bus' }));
  const ack2 = await ack2P;
  assert(ack2.deduped === true, 'second send deduped');
  assert(ack2.messageId === ack.messageId, 'same message id');

  console.log('ordering: send m2, m3 and check seq increments...');
  aliceWs.ws.send(JSON.stringify({ type: 'send', conversationId, clientMsgId: 'm2', body: 'second' }));
  const a2 = await next(aliceWs, 'ack');
  aliceWs.ws.send(JSON.stringify({ type: 'send', conversationId, clientMsgId: 'm3', body: 'third' }));
  const a3 = await next(aliceWs, 'ack');
  assert(a2.seq === '2' && a3.seq === '3', 'per-conversation seq increments (2,3)');

  console.log('history...');
  const histP = next(bobWs, 'history');
  bobWs.ws.send(JSON.stringify({ type: 'history', conversationId, limit: 50 }));
  const hist = await histP;
  assert(hist.messages.length === 3, 'three messages in history');

  aliceWs.ws.close();
  bobWs.ws.close();
  await delay(100);
  console.log('\nALL SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exit(1);
});
