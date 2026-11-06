import { eventIdOf } from '../src/events/event-id';
import { NewEvent } from '../src/events/event.model';

const base: NewEvent = {
  patientId: 'p-1',
  type: 'vitals',
  data: { heartRate: 72, bp: { systolic: 120, diastolic: 80 } },
  ts: new Date('2026-01-01T10:00:00Z'),
};

describe('eventIdOf', () => {
  it('is stable for the same event', () => {
    expect(eventIdOf(base)).toBe(eventIdOf({ ...base }));
  });

  it('ignores key order at any depth', () => {
    const reordered: NewEvent = { ...base, data: { bp: { diastolic: 80, systolic: 120 }, heartRate: 72 } };
    expect(eventIdOf(reordered)).toBe(eventIdOf(base));
  });

  it('treats equivalent timestamp notations as the same instant', () => {
    const withOffset: NewEvent = { ...base, ts: new Date('2026-01-01T12:00:00.000+02:00') };
    expect(eventIdOf(withOffset)).toBe(eventIdOf(base));
  });

  it.each([
    ['patientId', { patientId: 'p-2' }],
    ['type', { type: 'medication' }],
    ['ts', { ts: new Date('2026-01-01T10:00:00.001Z') }],
    ['data', { data: { heartRate: 73, bp: { systolic: 120, diastolic: 80 } } }],
  ])('changes when %s changes', (_field, change) => {
    expect(eventIdOf({ ...base, ...change })).not.toBe(eventIdOf(base));
  });

  it('keeps array order significant', () => {
    expect(eventIdOf({ ...base, data: { readings: [1, 2] } })).not.toBe(
      eventIdOf({ ...base, data: { readings: [2, 1] } }),
    );
  });
});
