import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { Collection, Db } from 'mongodb';
import { AppModule } from '../../src/app.module';
import { AppConfig, loadConfig, WorkerConfig } from '../../src/config/app-config';
import { MONGO_DB } from '../../src/database/database.module';
import { EventDocument } from '../../src/events/event.model';
import { EVENTS_COLLECTION, EventsRepository } from '../../src/events/events.repository';
import { configureApp } from '../../src/main';
import { EventWorker } from '../../src/processing/event-worker.service';
import { EXTERNAL_PROCESSOR, ExternalProcessor } from '../../src/processing/external-processor';

export interface TestApp {
  app: INestApplication;
  events: EventsRepository;
  worker: EventWorker;
  collection: Collection<EventDocument>;
  close(): Promise<void>;
}

export const testWorkerConfig: WorkerConfig = {
  ...loadConfig({}).worker,
  enabled: false,
  processingDelayMs: 0,
  processingTimeoutMs: 1_000,
  leaseMs: 5_000,
  maxAttempts: 3,
  retryBaseDelayMs: 10,
  reorderWindowMs: 0,
  idlePollMs: 10,
  shutdownGraceMs: 5_000,
};

export async function createTestApp(
  options: { worker?: Partial<WorkerConfig>; processor?: ExternalProcessor } = {},
): Promise<TestApp> {
  const config: AppConfig = {
    port: 0,
    mongoUri: process.env.MONGO_TEST_URI!,
    mongoDbName: `test_${randomUUID().slice(0, 8)}`,
    worker: { ...testWorkerConfig, ...options.worker },
  };

  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] });
  if (options.processor) {
    builder = builder.overrideProvider(EXTERNAL_PROCESSOR).useValue(options.processor);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  try {
    await app.init();
  } catch (err) {
    await app.close();
    throw err;
  }

  const db = app.get<Db>(MONGO_DB);
  return {
    app,
    events: app.get(EventsRepository),
    worker: app.get(EventWorker),
    collection: db.collection<EventDocument>(EVENTS_COLLECTION),
    close: async () => {
      await db.dropDatabase();
      await app.close();
    },
  };
}

export async function waitFor(predicate: () => Promise<boolean>, message: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for: ${message}`);
}
