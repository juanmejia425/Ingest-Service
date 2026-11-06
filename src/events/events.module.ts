import { Module } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsRepository } from './events.repository';

@Module({
  controllers: [EventsController],
  providers: [EventsRepository],
  exports: [EventsRepository],
})
export class EventsModule {}
