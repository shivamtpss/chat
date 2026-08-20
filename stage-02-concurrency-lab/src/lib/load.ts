/**
 * Small load-test toolkit used by every experiment.
 *
 * The key idea a beginner should take away: we do not just measure "how long
 * does ONE query take" (that was Stage 01). We measure what happens when MANY
 * requests arrive AT THE SAME TIME. That is concurrency.
 */

export interface LoadResult {
  total: number;
  ok: number;
  failed: number;
  wallMs: number; // total wall-clock time for the whole run
  throughput: number; // successful ops per second
  p50: number;
  p95: number;
  p99: number;
  max: number;
  errorsByType: Record<string, number>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/**
 * Fire `total` tasks but keep at most `concurrency` of them in flight at once.
 * This simulates "C users hitting the server simultaneously". Each task is
 * timed individually so we can report latency percentiles (p50/p95/p99), which
 * is how real systems are judged. An average hides the users who suffer; the
 * p99 is the slow tail that ruins experiences.
 */
export async function runLoad(
  total: number,
  concurrency: number,
  task: () => Promise<void>,
): Promise<LoadResult> {
  const latencies: number[] = [];
  const errorsByType: Record<string, number> = {};
  let ok = 0;
  let failed = 0;
  let launched = 0;

  const wallStart = process.hrtime.bigint();

  async function worker(): Promise<void> {
    while (true) {
      const myIndex = launched;
      if (myIndex >= total) return;
      launched += 1;
      const start = process.hrtime.bigint();
      try {
        await task();
        latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
        ok += 1;
      } catch (err) {
        failed += 1;
        const name = (err as Error)?.message?.slice(0, 40) ?? 'unknown';
        errorsByType[name] = (errorsByType[name] ?? 0) + 1;
      }
    }
  }

  // Launch `concurrency` workers that pull from the shared counter.
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
  latencies.sort((a, b) => a - b);

  return {
    total,
    ok,
    failed,
    wallMs,
    throughput: ok / (wallMs / 1000),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.length ? latencies[latencies.length - 1]! : 0,
    errorsByType,
  };
}

export function fmt(n: number): string {
  return n.toFixed(1);
}

export function printResult(label: string, r: LoadResult): void {
  console.log(`\n  ${label}`);
  console.log(
    `    ok=${r.ok} failed=${r.failed}  throughput=${fmt(r.throughput)} ops/s  wall=${fmt(r.wallMs)} ms`,
  );
  console.log(
    `    latency ms: p50=${fmt(r.p50)}  p95=${fmt(r.p95)}  p99=${fmt(r.p99)}  max=${fmt(r.max)}`,
  );
  if (r.failed > 0) {
    console.log(`    errors: ${JSON.stringify(r.errorsByType)}`);
  }
}

export function hr(): void {
  console.log('-'.repeat(72));
}
