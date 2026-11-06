import { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
  await (globalThis as { __MONGO_REPLSET__?: MongoMemoryReplSet }).__MONGO_REPLSET__?.stop();
}
