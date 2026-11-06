import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Db } from 'mongodb';
import { MONGO_DB } from '../database/database.module';
import { EventStats, EventsRepository } from '../events/events.repository';

@Controller()
export class OpsController {
  constructor(
    @Inject(MONGO_DB) private readonly db: Db,
    private readonly events: EventsRepository,
  ) {}

  @Get('health')
  async health(): Promise<{ status: 'ok' }> {
    try {
      await this.db.command({ ping: 1 });
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('MongoDB unreachable');
    }
  }

  @Get('stats')
  stats(): Promise<EventStats> {
    return this.events.stats();
  }
}
