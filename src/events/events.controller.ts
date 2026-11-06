import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { CreateEventDto } from './dto/create-event.dto';
import { EventDocument, EventStatus } from './event.model';
import { EventsRepository } from './events.repository';

export interface AcceptedEventResponse {
  id: string;
  status: EventStatus;
  duplicate: boolean;
}

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsRepository) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async ingest(
    @Body() dto: CreateEventDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AcceptedEventResponse> {
    const { event, duplicate } = await this.events.insert({
      patientId: dto.patientId,
      type: dto.type,
      data: dto.data,
      ts: new Date(dto.ts),
    });
    if (duplicate) res.status(HttpStatus.OK);
    return { id: event._id, status: event.status, duplicate };
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<EventDocument> {
    const event = await this.events.findById(id);
    if (!event) throw new NotFoundException(`Event ${id} not found`);
    return event;
  }
}
