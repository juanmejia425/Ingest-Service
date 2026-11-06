import { EventStatus, NewEvent } from '../src/events/event.model';
import { Claim, EventsRepository } from '../src/events/events.repository';
import { createTestApp, TestApp } from './support/test-app';

function event(patientId: string, minute: number, data: Record<string, unknown> = {}): NewEvent {
  return { patientId, type: 'vitals', data, ts: new Date(Date.UTC(2026, 0, 1, 10, minute)) };
}

function claimAs(owner: string, overrides: Partial<Claim> = {}): Claim {
  return { owner, leaseMs: 5_000, receivedBefore: new Date(Date.now() + 1_000), ...overrides };
}

describe('EventsRepository', () => {
  let t: TestApp;
  let repo: EventsRepository;

  beforeEach(async () => {
    t = await createTestApp();
    repo = t.events;
  });

  afterEach(() => t?.close());

  describe('insert', () => {
    it('stores a redelivered event only once', async () => {
      const first = await repo.insert(event('p1', 0, { hr: 70 }));
      const second = await repo.insert(event('p1', 0, { hr: 70 }));

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(second.event._id).toBe(first.event._id);
      expect(await t.collection.countDocuments()).toBe(1);
    });

    it('stores exactly one copy when the same event races in concurrently', async () => {
      const outcomes = await Promise.all(Array.from({ length: 20 }, () => repo.insert(event('p1', 0))));

      expect(outcomes.filter((o) => !o.duplicate)).toHaveLength(1);
      expect(await t.collection.countDocuments()).toBe(1);
    });

    it('reports the current status of an already processed duplicate', async () => {
      await repo.insert(event('p1', 0));
      const claimed = (await repo.claimNext(claimAs('w1')))!;
      await repo.complete({ id: claimed._id, owner: 'w1', attempt: 1 }, {}, false);

      const again = await repo.insert(event('p1', 0));
      expect(again).toMatchObject({ duplicate: true, event: { status: EventStatus.Completed } });
    });
  });

  describe('claimNext', () => {
    it("claims each patient's events in ts order, regardless of arrival order", async () => {
      await repo.insert(event('p1', 3));
      await repo.insert(event('p1', 1));
      await repo.insert(event('p1', 2));

      const order: number[] = [];
      for (let i = 0; i < 3; i++) {
        const claimed = (await repo.claimNext(claimAs('w1')))!;
        order.push(claimed.ts.getUTCMinutes());
        await repo.complete({ id: claimed._id, owner: 'w1', attempt: claimed.attempts }, {}, false);
      }
      expect(order).toEqual([1, 2, 3]);
    });

    it('never has two events of one patient in flight, but serves other patients meanwhile', async () => {
      await repo.insert(event('p1', 1));
      await repo.insert(event('p1', 2));
      await repo.insert(event('p2', 3));

      const first = await repo.claimNext(claimAs('w1'));
      const second = await repo.claimNext(claimAs('w2'));
      const third = await repo.claimNext(claimAs('w3'));

      expect(first).toMatchObject({ patientId: 'p1', status: EventStatus.Processing });
      expect(second).toMatchObject({ patientId: 'p2' });
      expect(third).toBeNull();
    });

    it('holds under many concurrent claimers for the same patient', async () => {
      for (let minute = 0; minute < 10; minute++) await repo.insert(event('p1', minute));

      const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => repo.claimNext(claimAs(`w${i}`))));

      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await t.collection.countDocuments({ status: EventStatus.Processing })).toBe(1);
    });

    it('leaves events inside the reorder window alone', async () => {
      await repo.insert(event('p1', 0));
      const tooFresh = await repo.claimNext(claimAs('w1', { receivedBefore: new Date(Date.now() - 60_000) }));
      expect(tooFresh).toBeNull();
    });
  });

  describe('leases', () => {
    it('lets another worker take over an expired lease, and fences out the previous owner', async () => {
      await repo.insert(event('p1', 0));
      const crashed = (await repo.claimNext(claimAs('crashed', { leaseMs: 1 })))!;
      await new Promise((resolve) => setTimeout(resolve, 10));

      const takeover = (await repo.claimNext(claimAs('healthy')))!;
      expect(takeover._id).toBe(crashed._id);
      expect(takeover).toMatchObject({ lockedBy: 'healthy', attempts: 2, status: EventStatus.Processing });

      const zombieWrite = await repo.complete({ id: crashed._id, owner: 'crashed', attempt: 1 }, {}, false);
      expect(zombieWrite).toBe(false);

      const ownerWrite = await repo.complete({ id: crashed._id, owner: 'healthy', attempt: 2 }, {}, false);
      expect(ownerWrite).toBe(true);
    });

    it('keeps the patient blocked while an event waits for its retry', async () => {
      await repo.insert(event('p1', 1));
      await repo.insert(event('p1', 2));
      const claimed = (await repo.claimNext(claimAs('w1')))!;

      const retry = await repo.beginRetry({ id: claimed._id, owner: 'w1', attempt: 1 }, 'boom', 5_000);

      expect(retry).toEqual({ id: claimed._id, owner: 'w1', attempt: 2 });
      expect(await repo.claimNext(claimAs('w2'))).toBeNull();
    });
  });

  describe('hasLaterCompletedEvent', () => {
    it('detects an event that arrives after a later one was already applied', async () => {
      await repo.insert(event('p1', 5));
      const later = (await repo.claimNext(claimAs('w1')))!;
      await repo.complete({ id: later._id, owner: 'w1', attempt: 1 }, {}, false);

      expect(await repo.hasLaterCompletedEvent('p1', event('p1', 1).ts)).toBe(true);
      expect(await repo.hasLaterCompletedEvent('p1', event('p1', 9).ts)).toBe(false);
      expect(await repo.hasLaterCompletedEvent('p2', event('p2', 1).ts)).toBe(false);
    });
  });
});
