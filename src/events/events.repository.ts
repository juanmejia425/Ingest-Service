import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Collection, Db, MongoServerError } from 'mongodb';
import { MONGO_DB } from '../database/database.module';
import { eventIdOf } from './event-id';
import { EventDocument, EventStatus, NewEvent } from './event.model';

export const EVENTS_COLLECTION = 'events';

const DUPLICATE_KEY = 11000;
const CLAIM_CONTENTION_RETRIES = 3;

export interface InsertOutcome {
  event: EventDocument;
  duplicate: boolean;
}

export interface Claim {
  owner: string;
  leaseMs: number;
  receivedBefore: Date;
}

export interface EventStats {
  counts: Record<EventStatus, number>;
  oldestPendingAgeMs: number | null;
  lateArrivals: number;
  retriedEvents: number;
}

export interface LeaseToken {
  id: string;
  owner: string;
  attempt: number;
}

function isDuplicateKey(err: unknown): boolean {
  return err instanceof MongoServerError && err.code === DUPLICATE_KEY;
}

@Injectable()
export class EventsRepository implements OnModuleInit {
  private readonly events: Collection<EventDocument>;

  constructor(@Inject(MONGO_DB) db: Db) {
    this.events = db.collection<EventDocument>(EVENTS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.events.createIndexes([
      {
        // At most one in-flight event per patient, across all workers and instances.
        key: { patientId: 1 },
        name: 'one_in_flight_per_patient',
        unique: true,
        partialFilterExpression: { status: EventStatus.Processing },
      },
      { key: { status: 1, ts: 1 }, name: 'claim_order' },
      { key: { status: 1, leaseExpiresAt: 1 }, name: 'expired_leases' },
      { key: { patientId: 1, ts: 1 }, name: 'patient_timeline' },
    ]);
  }

  async insert(newEvent: NewEvent, receivedAt = new Date()): Promise<InsertOutcome> {
    const event: EventDocument = {
      _id: eventIdOf(newEvent),
      ...newEvent,
      receivedAt,
      status: EventStatus.Pending,
      attempts: 0,
    };
    try {
      await this.events.insertOne(event);
      return { event, duplicate: false };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const existing = await this.findById(event._id);
      if (!existing) throw err;
      return { event: existing, duplicate: true };
    }
  }

  findById(id: string): Promise<EventDocument | null> {
    return this.events.findOne({ _id: id });
  }

  async claimNext(claim: Claim): Promise<EventDocument | null> {
    return (await this.reclaimExpired(claim)) ?? (await this.claimPending(claim));
  }

  private reclaimExpired({ owner, leaseMs }: Claim): Promise<EventDocument | null> {
    const now = new Date();
    return this.events.findOneAndUpdate(
      { status: EventStatus.Processing, leaseExpiresAt: { $lt: now } },
      {
        $set: { lockedBy: owner, leaseExpiresAt: new Date(now.getTime() + leaseMs), startedAt: now },
        $inc: { attempts: 1 },
      },
      { sort: { leaseExpiresAt: 1 }, returnDocument: 'after' },
    );
  }

  private async claimPending({ owner, leaseMs, receivedBefore }: Claim): Promise<EventDocument | null> {
    for (let i = 0; i < CLAIM_CONTENTION_RETRIES; i++) {
      // Only an optimisation; the unique index is what prevents two claims for one patient.
      const busyPatients = await this.events.distinct('patientId', { status: EventStatus.Processing });
      const now = new Date();
      try {
        return await this.events.findOneAndUpdate(
          {
            status: EventStatus.Pending,
            receivedAt: { $lte: receivedBefore },
            patientId: { $nin: busyPatients },
          },
          {
            $set: {
              status: EventStatus.Processing,
              lockedBy: owner,
              leaseExpiresAt: new Date(now.getTime() + leaseMs),
              startedAt: now,
            },
            $inc: { attempts: 1 },
          },
          { sort: { ts: 1 }, returnDocument: 'after' },
        );
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
      }
    }
    return null;
  }

  async hasLaterCompletedEvent(patientId: string, ts: Date): Promise<boolean> {
    const later = await this.events.findOne(
      { patientId, ts: { $gt: ts }, status: EventStatus.Completed },
      { projection: { _id: 1 } },
    );
    return later !== null;
  }

  async complete(lease: LeaseToken, result: unknown, lateArrival: boolean): Promise<boolean> {
    return this.releaseWith(lease, {
      $set: { status: EventStatus.Completed, completedAt: new Date(), result, lateArrival },
    });
  }

  async fail(lease: LeaseToken, error: string): Promise<boolean> {
    return this.releaseWith(lease, {
      $set: { status: EventStatus.Failed, completedAt: new Date(), lastError: error },
    });
  }

  // Keeps the claim during backoff so later events of the patient can't overtake this one.
  async beginRetry(lease: LeaseToken, error: string, holdMs: number): Promise<LeaseToken | null> {
    const updated = await this.events.updateOne(this.leaseFilter(lease), {
      $set: { lastError: error, leaseExpiresAt: new Date(Date.now() + holdMs) },
      $inc: { attempts: 1 },
    });
    return updated.modifiedCount === 1 ? { ...lease, attempt: lease.attempt + 1 } : null;
  }

  async stats(): Promise<EventStats> {
    const [byStatus, oldestPending, lateArrivals, retriedEvents] = await Promise.all([
      this.events.aggregate<{ _id: EventStatus; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
      this.events.findOne({ status: EventStatus.Pending }, { sort: { receivedAt: 1 }, projection: { receivedAt: 1 } }),
      this.events.countDocuments({ lateArrival: true }),
      this.events.countDocuments({ attempts: { $gt: 1 } }),
    ]);

    const counts = Object.fromEntries(Object.values(EventStatus).map((s) => [s, 0])) as Record<EventStatus, number>;
    for (const { _id, n } of byStatus) counts[_id] = n;

    return {
      counts,
      oldestPendingAgeMs: oldestPending ? Date.now() - oldestPending.receivedAt.getTime() : null,
      lateArrivals,
      retriedEvents,
    };
  }

  private async releaseWith(lease: LeaseToken, update: { $set: Partial<EventDocument> }): Promise<boolean> {
    const updated = await this.events.updateOne(this.leaseFilter(lease), {
      ...update,
      $unset: { lockedBy: '', leaseExpiresAt: '' },
    });
    return updated.modifiedCount === 1;
  }

  // Fencing: a worker whose lease was taken over can no longer write to the event.
  private leaseFilter({ id, owner, attempt }: LeaseToken) {
    return { _id: id, status: EventStatus.Processing, lockedBy: owner, attempts: attempt };
  }
}
