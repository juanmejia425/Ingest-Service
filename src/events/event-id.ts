import { createHash } from 'node:crypto';
import { NewEvent } from './event.model';

// Senders don't provide an event id, so a redelivery is recognised by its content.
export function eventIdOf(event: NewEvent): string {
  const canonical = canonicalJson({
    patientId: event.patientId,
    type: event.type,
    ts: event.ts.toISOString(),
    data: event.data,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
