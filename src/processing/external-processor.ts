import { Inject, Injectable } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { EventDocument } from '../events/event.model';

export const EXTERNAL_PROCESSOR = Symbol('EXTERNAL_PROCESSOR');

// Calls can be repeated after a crash, so implementations must use event._id as an idempotency key.
export interface ExternalProcessor {
  process(event: EventDocument): Promise<unknown>;
}

@Injectable()
export class SimulatedExternalProcessor implements ExternalProcessor {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async process(event: EventDocument): Promise<unknown> {
    const { processingDelayMs, processorFailureRate } = this.config.worker;
    await sleep(processingDelayMs);
    if (Math.random() < processorFailureRate) {
      throw new Error('Simulated external system failure');
    }
    return { processedAt: new Date().toISOString(), idempotencyKey: event._id };
  }
}
