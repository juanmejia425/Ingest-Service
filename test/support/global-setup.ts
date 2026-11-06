import { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalSetup(): Promise<void> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  (globalThis as { __MONGO_REPLSET__?: MongoMemoryReplSet }).__MONGO_REPLSET__ = replSet;
  process.env.MONGO_TEST_URI = replSet.getUri();
}
