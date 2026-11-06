// Checks a load-test run for lost, duplicated or misordered events. Usage: npm run verify
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoClient } from 'mongodb';
import { EventDocument, EventStatus } from '../src/events/event.model';
import { EVENTS_COLLECTION } from '../src/events/events.repository';

const MONGO_URI = process.env.MONGO_URI ?? 'mongodb://localhost:27017/?directConnection=true';
const MONGO_DB = process.env.MONGO_DB ?? 'ingest';
const MANIFEST_PATH = process.env.MANIFEST_PATH ?? 'load-test-manifest.json';
const WAIT_TIMEOUT_S = Number(process.env.WAIT_TIMEOUT_S ?? 600);

interface Manifest {
  runId: string;
  ids: string[];
}

function check(ok: boolean, label: string, detail = ''): boolean {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function unflaggedOrderViolations(events: EventDocument[]): number {
  const byPatient = new Map<string, EventDocument[]>();
  for (const event of events) {
    byPatient.set(event.patientId, [...(byPatient.get(event.patientId) ?? []), event]);
  }
  let violations = 0;
  for (const timeline of byPatient.values()) {
    timeline.sort((a, b) => a.completedAt!.getTime() - b.completedAt!.getTime());
    let latestTs = 0;
    for (const event of timeline) {
      if (event.ts.getTime() < latestTs && !event.lateArrival) violations++;
      latestTs = Math.max(latestTs, event.ts.getTime());
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  const client = await new MongoClient(MONGO_URI).connect();
  const events = client.db(MONGO_DB).collection<EventDocument>(EVENTS_COLLECTION);
  const ofRun = { patientId: { $regex: `^run-${manifest.runId}-` } };

  try {
    const deadline = Date.now() + WAIT_TIMEOUT_S * 1000;
    for (;;) {
      const open = await events.countDocuments({
        ...ofRun,
        status: { $in: [EventStatus.Pending, EventStatus.Processing] },
      });
      if (open === 0) break;
      if (Date.now() > deadline) {
        console.log(`Gave up waiting: ${open} events still open`);
        break;
      }
      console.log(`Waiting for ${open} events to finish processing...`);
      await sleep(5000);
    }

    const stored = await events.find(ofRun).toArray();
    const storedIds = new Set(stored.map((e) => e._id));
    const missing = manifest.ids.filter((id) => !storedIds.has(id));
    const completed = stored.filter((e) => e.status === EventStatus.Completed);
    const failed = stored.filter((e) => e.status === EventStatus.Failed);
    const open = stored.filter((e) => e.status === EventStatus.Pending || e.status === EventStatus.Processing);

    console.log(`\nRun ${manifest.runId}: ${manifest.ids.length} acknowledged, ${stored.length} stored\n`);
    const results = [
      check(missing.length === 0, 'every acknowledged event is stored', `${missing.length} missing`),
      check(stored.length === manifest.ids.length, 'one document per distinct event', `${stored.length} documents`),
      check(open.length === 0, 'every event reached a final state', `${open.length} still open`),
      check(failed.length === 0, 'no event failed permanently', `${failed.length} failed`),
      check(
        unflaggedOrderViolations(completed) === 0,
        'per-patient ts order respected (late arrivals flagged)',
        `${completed.filter((e) => e.lateArrival).length} late arrivals flagged`,
      ),
    ];
    const retried = stored.filter((e) => e.attempts > 1).length;
    console.log(`INFO  ${retried} events needed more than one attempt (retries or takeovers after a crash)`);

    if (results.includes(false)) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

void main();
