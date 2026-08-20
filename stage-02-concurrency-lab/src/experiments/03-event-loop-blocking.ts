import { createHash } from 'node:crypto';
import { runLoad, printResult, hr } from '../lib/load.js';

/**
 * EXPERIMENT 3: Blocking the event loop vs staying async.
 *
 * Beginner framing: Node.js (like many chat servers) runs your JavaScript on a
 * SINGLE main thread called the "event loop". It is brilliant at juggling
 * thousands of waiting connections... as long as you never make it do heavy CPU
 * work in one go. If one request sits and grinds the CPU synchronously, the
 * event loop cannot serve ANYONE else until it finishes. One selfish request
 * freezes the whole server.
 *
 * We simulate a mix of light requests (instant) and heavy requests (a CPU-heavy
 * hashing loop), two ways:
 *   A) heavy work done in one blocking synchronous burst
 *   B) heavy work broken into small chunks that yield back to the event loop
 * We measure how much the LIGHT requests suffer in each case.
 */

// Simulated light request: trivial async work (like a fast cache hit).
async function lightRequest(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

// Heavy CPU work, done all at once. While this runs, the event loop is frozen.
function heavyBlocking(iterations: number): void {
  let h = 'seed';
  for (let i = 0; i < iterations; i++) {
    h = createHash('sha256').update(h).digest('hex');
  }
}

// Same heavy work, but yielding to the event loop every chunk so other
// requests can be served in between. This keeps the server responsive.
async function heavyChunked(iterations: number, chunk = 2000): Promise<void> {
  let h = 'seed';
  for (let i = 0; i < iterations; i++) {
    h = createHash('sha256').update(h).digest('hex');
    if (i % chunk === 0) await new Promise((r) => setImmediate(r));
  }
}

export async function run(): Promise<void> {
  hr();
  console.log('EXPERIMENT 3: Blocking the event loop vs staying responsive');
  console.log('A flood of light requests, with a few CPU-heavy ones mixed in.');
  hr();

  const HEAVY_ITER = 150_000; // tuned so one heavy call is clearly noticeable
  const LIGHT = 800;
  const HEAVY = 8;
  const CONCURRENCY = 50;

  async function scenario(label: string, mode: 'blocking' | 'chunked'): Promise<void> {
    const tasks: Array<'light' | 'heavy'> = [];
    for (let i = 0; i < LIGHT; i++) tasks.push('light');
    for (let i = 0; i < HEAVY; i++) tasks.push('heavy');
    for (let i = tasks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tasks[i], tasks[j]] = [tasks[j]!, tasks[i]!];
    }
    let cursor = 0;

    const result = await runLoad(tasks.length, CONCURRENCY, async () => {
      const kind = tasks[cursor++];
      if (kind === 'heavy') {
        if (mode === 'blocking') heavyBlocking(HEAVY_ITER);
        else await heavyChunked(HEAVY_ITER);
      } else {
        await lightRequest();
      }
    });
    printResult(label, result);
  }

  await scenario('BLOCKING: heavy work in one synchronous burst', 'blocking');
  await scenario('CHUNKED: heavy work yields to the event loop', 'chunked');

  console.log('\n  What to notice:');
  console.log('   - In BLOCKING mode the light requests\' p99 spikes: they were stuck waiting');
  console.log('     while a heavy request hogged the single thread. Everyone freezes together.');
  console.log('   - In CHUNKED mode the heavy work periodically yields, so light requests keep');
  console.log('     flowing and their p99 stays low.');
  console.log('\n  Real world: never do big CPU work inline on the event loop. Offload it (worker');
  console.log('  threads, a separate service, a queue) or chunk it. This is why chat gateways keep');
  console.log('  per-connection work tiny: one greedy handler must not stall thousands of sockets.');
}
