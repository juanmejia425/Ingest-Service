import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { EventWorker } from './event-worker.service';
import { EXTERNAL_PROCESSOR, SimulatedExternalProcessor } from './external-processor';

@Module({
  imports: [EventsModule],
  providers: [EventWorker, { provide: EXTERNAL_PROCESSOR, useClass: SimulatedExternalProcessor }],
  exports: [EventWorker],
})
export class ProcessingModule {}
