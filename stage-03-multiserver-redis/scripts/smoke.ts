import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * End-to-end smoke test for the Stage 03 headline feature: CROSS-SERVER
 * delivery. Alice connects to server A, Bob connects to server B. When Alice
 * sends, Bob (on a DIFFERENT process) must receive it, routed through Redis.
 *
 * Prereqs (see README):
 *   npm run infra:up
 *   npm run start:a      # terminal 1  (SERVER_ID=A PORT=3001)
 *   npm run start:b      # terminal 2  (SERVER_ID=B PORT=3002)
 *   npm run smoke        # terminal 3
 */
const A = process.env.A_BASE ?? 'http://localhost:3001';
const B = process.env.B_BASE ?? 'http://localhost:3002';

async function post(base: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${base}${path} -> ${res.status}`);
  return res.json();
}

interface Client {
  ws: WebSocket;
  queue: any[];
  waiters: Array<{ type: string; resolve: (m: any) => void }>;
}

function open(base: string, token: string): Promise<Client> {
  const wsBase = base.replace('http', 'ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
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

function next(client: Client, type: string, timeoutMs = 4000): Promise<any> {
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
  console.log('health on both servers...');
  const ha = (await fetch(`${A}/health`).then((r) => r.json())) as { status: string; server: string };
  const hb = (await fetch(`${B}/health`).then((r) => r.json())) as { status: string; server: string };
  assert(ha.status === 'ok' && hb.status === 'ok', 'both servers healthy');
  assert(ha.server !== hb.server, 'servers report distinct ids');
  console.log(`  server A id=${ha.server}, server B id=${hb.server}`);

  console.log('register alice + bob (via server A HTTP)...');
  const alice = await post(A, '/register', { username: 'alice', displayName: 'Alice' });
  const bob = await post(A, '/register', { username: 'bob', displayName: 'Bob' });

  console.log('create their 1:1 conversation...');
  const { conversationId } = await post(A, '/conversations/direct', {
    userA: alice.user.id,
    userB: bob.user.id,
  });

  console.log('alice -> server A, bob -> server B (DIFFERENT processes)...');
  const aliceWs = await open(A, alice.token);
  const bobWs = await open(B, bob.token);
  const aReady = await next(aliceWs, 'ready');
  const bReady = await next(bobWs, 'ready');
  assert(aReady.server !== bReady.server, 'alice and bob are on different servers');
  console.log(`  alice on ${aReady.server}, bob on ${bReady.server}`);

  // Give presence a moment to publish to Redis.
  await delay(200);

  console.log('alice sends; bob (other server) must receive via Redis...');
  const ackP = next(aliceWs, 'ack');
  const recvP = next(bobWs, 'message');
  aliceWs.ws.send(
    JSON.stringify({ type: 'send', conversationId, clientMsgId: 'm1', body: 'hello across servers' }),
  );
  const ack = await ackP;
  const recv = await recvP;
  assert(ack.messageId, 'alice got an ack');
  assert(recv.message.body === 'hello across servers', 'bob received the body');
  assert(recv.viaServer === bReady.server, 'delivered by bob\'s own server');
  console.log(`  bob received it, delivered via server ${recv.viaServer} (cross-server hop worked)`);

  console.log('idempotency across the cluster: resend same clientMsgId...');
  const ack2P = next(aliceWs, 'ack');
  aliceWs.ws.send(
    JSON.stringify({ type: 'send', conversationId, clientMsgId: 'm1', body: 'hello across servers' }),
  );
  const ack2 = await ack2P;
  assert(ack2.deduped === true, 'second send deduped');
  assert(ack2.messageId === ack.messageId, 'same message id on retry');

  console.log('history is shared (bob fetches from server B what alice sent via A)...');
  const histP = next(bobWs, 'history');
  bobWs.ws.send(JSON.stringify({ type: 'history', conversationId, limit: 50 }));
  const hist = await histP;
  assert(hist.messages.length === 1, 'exactly one message in shared history');

  aliceWs.ws.close();
  bobWs.ws.close();
  await delay(100);
  console.log('\nALL CROSS-SERVER SMOKE CHECKS PASSED');
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exit(1);
});
