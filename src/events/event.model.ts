export enum EventStatus {
  Pending = 'pending',
  Processing = 'processing',
  Completed = 'completed',
  Failed = 'failed',
}

export interface EventDocument {
  _id: string;
  patientId: string;
  type: string;
  data: Record<string, unknown>;
  ts: Date;
  receivedAt: Date;

  status: EventStatus;
  attempts: number;
  lockedBy?: string;
  leaseExpiresAt?: Date;

  startedAt?: Date;
  completedAt?: Date;
  result?: unknown;
  lastError?: string;
  lateArrival?: boolean;
}

export interface NewEvent {
  patientId: string;
  type: string;
  data: Record<string, unknown>;
  ts: Date;
}
