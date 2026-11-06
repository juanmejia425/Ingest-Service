import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { APP_CONFIG, AppConfig, WorkerConfig } from '../config/app-config';
import { EventDocument } from '../events/event.model';
import { EventsRepository, LeaseToken } from '../events/events.repository';
import { EXTERNAL_PROCESSOR, ExternalProcessor } from './external-processor';

const MAX_BACKOFF_MS = 60_000;

type AttemptOutcome = { ok: true; result: unknown } | { ok: false; error: string };

@Injectable()
export class EventWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(EventWorker.name);
  private readonly config: WorkerConfig;
  readonly owner = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  private readonly inFlight = new Set<Promise<void>>();
  private running = false;
  private dispatcher?: Promise<void>;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly events: EventsRepository,
    @Inject(EXTERNAL_PROCESSOR) private readonly processor: ExternalProcessor,
  ) {
    this.config = config.worker;
  }

  onApplicationBootstrap(): void {
    if (this.config.enabled) this.start();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Shutting down (${signal ?? 'no signal'}), draining ${this.inFlight.size} in-flight events`);
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.dispatcher = this.dispatch();
    this.logger.log(`Worker ${this.owner} started with concurrency ${this.config.concurrency}`);
  }

  // Events still running after the grace period are picked up elsewhere once their lease expires.
  async stop(): Promise<void> {
    this.running = false;
    await this.dispatcher;
    const drained = await Promise.race([
      Promise.all(this.inFlight).then(() => true),
      sleep(this.config.shutdownGraceMs, false, { ref: false }),
    ]);
    if (!drained) {
      this.logger.warn(`${this.inFlight.size} events still in flight; their leases will expire and be reclaimed`);
    }
  }

  private async dispatch(): Promise<void> {
    while (this.running) {
      if (this.inFlight.size >= this.config.concurrency) {
        await Promise.race(this.inFlight);
        continue;
      }
      const event = await this.claimNext();
      if (!event) {
        await sleep(this.config.idlePollMs);
        continue;
      }
      const task = this.handle(event).finally(() => this.inFlight.delete(task));
      this.inFlight.add(task);
    }
  }

  private async claimNext(): Promise<EventDocument | null> {
    try {
      return await this.events.claimNext({
        owner: this.owner,
        leaseMs: this.config.leaseMs,
        receivedBefore: new Date(Date.now() - this.config.reorderWindowMs),
      });
    } catch (err) {
      this.logger.error(`Claiming failed: ${errorMessage(err)}`);
      return null;
    }
  }

  async handle(event: EventDocument): Promise<void> {
    let lease: LeaseToken | null = { id: event._id, owner: this.owner, attempt: event.attempts };
    try {
      // Attempts are counted at claim time, so an event that keeps crashing its worker also runs out.
      if (lease.attempt > this.config.maxAttempts) {
        await this.events.fail(lease, `Gave up after ${this.config.maxAttempts} attempts`);
        this.logger.error(`Event ${event._id} failed: attempts exhausted across restarts`);
        return;
      }

      const lateArrival = await this.events.hasLaterCompletedEvent(event.patientId, event.ts);
      if (lateArrival) {
        this.logger.warn(`Event ${event._id} for patient ${event.patientId} arrived after later events were applied`);
      }

      while (lease) {
        const outcome = await this.attempt(event);
        if (outcome.ok) {
          const stored = await this.events.complete(lease, outcome.result, lateArrival);
          if (!stored) this.logger.warn(`Event ${event._id}: lease lost before completion, result discarded`);
          return;
        }

        if (lease.attempt >= this.config.maxAttempts) {
          await this.events.fail(lease, outcome.error);
          this.logger.error(`Event ${event._id} failed after ${lease.attempt} attempts: ${outcome.error}`);
          return;
        }

        const backoffMs = this.backoffMs(lease.attempt);
        lease = await this.events.beginRetry(lease, outcome.error, backoffMs + this.config.leaseMs);
        if (!lease) {
          this.logger.warn(`Event ${event._id}: lease lost before retry`);
          return;
        }
        await sleep(backoffMs);
      }
    } catch (err) {
      this.logger.error(`Event ${event._id}: ${errorMessage(err)}; will be retried after lease expiry`);
    }
  }

  private async attempt(event: EventDocument): Promise<AttemptOutcome> {
    try {
      const result = await withTimeout(this.processor.process(event), this.config.processingTimeoutMs);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  }

  private backoffMs(attempt: number): number {
    return Math.min(this.config.retryBaseDelayMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = sleep(ms, undefined, { ref: false }).then(() => {
    throw new Error(`External call timed out after ${ms}ms`);
  });
  return Promise.race([promise, timeout]);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
