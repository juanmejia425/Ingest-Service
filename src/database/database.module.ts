import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Db, MongoClient } from 'mongodb';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export const MONGO_CLIENT = Symbol('MONGO_CLIENT');
export const MONGO_DB = Symbol('MONGO_DB');

@Global()
@Module({
  providers: [
    {
      provide: MONGO_CLIENT,
      inject: [APP_CONFIG],
      useFactory: async (config: AppConfig): Promise<MongoClient> => {
        const client = new MongoClient(config.mongoUri, {
          writeConcern: { w: 'majority', journal: true },
          readConcern: { level: 'majority' },
          retryWrites: true,
        });
        await client.connect();
        return client;
      },
    },
    {
      provide: MONGO_DB,
      inject: [MONGO_CLIENT, APP_CONFIG],
      useFactory: (client: MongoClient, config: AppConfig): Db => client.db(config.mongoDbName),
    },
  ],
  exports: [MONGO_CLIENT, MONGO_DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(@Inject(MONGO_CLIENT) private readonly client: MongoClient) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
    this.logger.log('MongoDB connection closed');
  }
}
