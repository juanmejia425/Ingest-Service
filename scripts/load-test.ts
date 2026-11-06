// Usage: RATE_PER_MIN=1000 DURATION_S=120 npm run load-test
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN ?? 1000);
const DURATION_S = Number(process.env.DURATION_S ?? 120);
const PATIENTS = Number(process.env.PATIENTS ?? 200);
const DUPLICATE_RATE = Number(process.env.DUPLICATE_RATE ?? 0.1);
const MAX_TS_SKEW_MS = Number(process.env.MAX_TS_SKEW_MS ?? 3000);
const REQUEST_TIMEOUT_MS = 5000;
const MANIFEST_PATH = process.env.MANIFEST_PATH ?? 'load-test-manifest.json';

interface Payload {
  patientId: string;
  type: string;
  data: Record<string, unknown>;
  ts: string;
}

const runId = randomUUID().slice(0, 8);
const acknowledged = new Map<Payload, string>();
const stats = { requests: 0, accepted: 0, duplicateAcks: 0, retries: 0, rejected: 0, latencies: [] as number[] };

function makeEvent(seq: number): Payload {
  const patient = Math.floor(Math.random() * PATIENTS);
  return {
    patientId: `run-${runId}-patient-${patient}`,
    type: 'vitals',
    data: { seq, heartRate: 60 + Math.floor(Math.random() * 40) },
    ts: new Date(Date.now() - Math.floor(Math.random() * MAX_TS_SKEW_MS)).toISOString(),
  };
}

async function deliver(event: Payload): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) {
      stats.retries++;
      await sleep(Math.min(500 * 2 ** attempt, 10_000));
    }
    const started = Date.now();
    try {
      stats.requests++;
      const res = await fetch(`${BASE_URL}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status >= 500) continue;
      if (res.status !== 200 && res.status !== 202) {
        stats.rejected++;
        console.error(`Rejected (${res.status}):`, await res.text());
        return;
      }
      stats.latencies.push(Date.now() - started);
      const body = (await res.json()) as { id: string; duplicate: boolean };
      if (body.duplicate) stats.duplicateAcks++;
      else stats.accepted++;
      acknowledged.set(event, body.id);
      return;
    } catch {
      // service unreachable, retry
    }
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report(label: string): void {
  console.log(
    `${label} unique=${acknowledged.size} accepted=${stats.accepted} duplicateAcks=${stats.duplicateAcks} ` +
      `retries=${stats.retries} rejected=${stats.rejected} ackLatency p50=${percentile(stats.latencies, 50)}ms ` +
      `p99=${percentile(stats.latencies, 99)}ms`,
  );
}

async function main(): Promise<void> {
  const total = Math.round((RATE_PER_MIN * DURATION_S) / 60);
  const intervalMs = 60_000 / RATE_PER_MIN;
  console.log(`Run ${runId}: ${total} events at ${RATE_PER_MIN}/min over ${DURATION_S}s to ${BASE_URL}`);

  const deliveries: Promise<void>[] = [];
  const progress = setInterval(() => report('[progress]'), 10_000);
  const startedAt = Date.now();

  for (let seq = 0; seq < total; seq++) {
    const event = makeEvent(seq);
    deliveries.push(deliver(event));
    if (Math.random() < DUPLICATE_RATE) {
      deliveries.push(sleep(Math.random() * 5_000).then(() => deliver(event)));
    }
    const nextAt = startedAt + (seq + 1) * intervalMs;
    await sleep(Math.max(0, nextAt - Date.now()));
  }

  await Promise.all(deliveries);
  clearInterval(progress);
  report('[done]');

  const uniqueIds = [...new Set(acknowledged.values())];
  writeFileSync(
    MANIFEST_PATH,
    JSON.stringify({ runId, sent: total, rejected: stats.rejected, ids: uniqueIds }, null, 2),
  );
  console.log(`Manifest with ${uniqueIds.length} acknowledged ids written to ${MANIFEST_PATH}`);
  if (uniqueIds.length !== total - stats.rejected) {
    console.error(`Expected ${total - stats.rejected} distinct ids, got ${uniqueIds.length}`);
    process.exitCode = 1;
  }
}

void main();
