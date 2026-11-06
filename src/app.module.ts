import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from './config/app-config';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { OpsController } from './ops/ops.controller';
import { ProcessingModule } from './processing/processing.module';

@Global()
@Module({})
class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), DatabaseModule, EventsModule, ProcessingModule],
      controllers: [OpsController],
    };
  }
}
