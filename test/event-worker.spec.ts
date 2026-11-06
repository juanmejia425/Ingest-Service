import { EventDocument, EventStatus, NewEvent } from '../src/events/event.model';
import { ExternalProcessor } from '../src/processing/external-processor';
import { createTestApp, TestApp, waitFor } from './support/test-app';

class FakeProcessor implements ExternalProcessor {
  readonly calls: EventDocument[] = [];
  private readonly failuresLeft = new Map<string, number>();

  constructor(
    private readonly failuresBeforeSuccess = 0,
    private readonly delayMs = 0,
  ) {}

  async process(event: EventDocument): Promise<unknown> {
    this.calls.push(event);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const left = this.failuresLeft.get(event._id) ?? this.failuresBeforeSuccess;
    if (left > 0) {
      this.failuresLeft.set(event._id, left - 1);
      throw new Error('downstream unavailable');
    }
    return { ok: true };
  }
}

function event(patientId: string, minute: number): NewEvent {
  return { patientId, type: 'vitals', data: { minute }, ts: new Date(Date.UTC(2026, 0, 1, 10, minute)) };
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe('EventWorker', () => {
  let t: TestApp;

  afterEach(() => t?.close());

  const allSettled = () => async () =>
    (await t.collection.countDocuments({ status: { $in: [EventStatus.Pending, EventStatus.Processing] } })) === 0;

  it('processes every event exactly once and each patient in ts order', async () => {
    const processor = new FakeProcessor(0, 5);
    t = await createTestApp({ worker: { concurrency: 8 }, processor });

    const patients = ['p1', 'p2', 'p3', 'p4'];
    const sent = patients.flatMap((p) => Array.from({ length: 10 }, (_, minute) => event(p, minute)));
    for (const e of shuffle([...sent, ...sent])) await t.events.insert(e);

    t.worker.start();
    await waitFor(allSettled(), 'all events processed');

    expect(await t.collection.countDocuments({ status: EventStatus.Completed })).toBe(sent.length);
    expect(processor.calls).toHaveLength(sent.length);
    for (const patient of patients) {
      const minutes = processor.calls.filter((c) => c.patientId === patient).map((c) => c.ts.getUTCMinutes());
      expect(minutes).toEqual([...Array(10).keys()]);
    }
  });

  it('retries a transient failure under the same claim and then completes', async () => {
    const processor = new FakeProcessor(1);
    t = await createTestApp({ processor });
    const { event: stored } = await t.events.insert(event('p1', 0));

    t.worker.start();
    await waitFor(allSettled(), 'event processed');

    expect(await t.events.findById(stored._id)).toMatchObject({
      status: EventStatus.Completed,
      attempts: 2,
      lastError: 'downstream unavailable',
    });
  });

  it('parks a permanently failing event as failed and moves on with the patient', async () => {
    const processor = new FakeProcessor(Number.POSITIVE_INFINITY);
    t = await createTestApp({ worker: { maxAttempts: 3 }, processor });
    const { event: poison } = await t.events.insert(event('p1', 0));
    await t.events.insert(event('p1', 1));

    t.worker.start();
    await waitFor(allSettled(), 'events settled');

    expect(await t.events.findById(poison._id)).toMatchObject({ status: EventStatus.Failed, attempts: 3 });
    expect(await t.collection.countDocuments({ patientId: 'p1', status: EventStatus.Failed })).toBe(2);
  });

  it('gives up on an event that keeps crashing its workers, without calling downstream again', async () => {
    const processor = new FakeProcessor();
    t = await createTestApp({ worker: { maxAttempts: 3 }, processor });
    const { event: stored } = await t.events.insert(event('p1', 0));
    await t.collection.updateOne(
      { _id: stored._id },
      { $set: { status: EventStatus.Processing, attempts: 3, lockedBy: 'dead', leaseExpiresAt: new Date(0) } },
    );

    t.worker.start();
    await waitFor(allSettled(), 'event settled');

    expect(await t.events.findById(stored._id)).toMatchObject({ status: EventStatus.Failed, attempts: 4 });
    expect(processor.calls).toHaveLength(0);
  });

  it('flags an event that arrives after a later one was already applied', async () => {
    t = await createTestApp({ processor: new FakeProcessor() });
    await t.events.insert(event('p1', 5));
    t.worker.start();
    await waitFor(allSettled(), 'first event processed');

    const { event: late } = await t.events.insert(event('p1', 1));
    await waitFor(allSettled(), 'late event processed');

    expect(await t.events.findById(late._id)).toMatchObject({ status: EventStatus.Completed, lateArrival: true });
  });

  it('drains in-flight work on shutdown instead of abandoning it', async () => {
    t = await createTestApp({ processor: new FakeProcessor(0, 300) });
    const { event: stored } = await t.events.insert(event('p1', 0));

    t.worker.start();
    await waitFor(async () => (await t.events.findById(stored._id))?.status === EventStatus.Processing, 'claimed');
    await t.worker.stop();

    expect(await t.events.findById(stored._id)).toMatchObject({ status: EventStatus.Completed });
  });
});
