import request from 'supertest';
import { EventStatus } from '../src/events/event.model';
import { createTestApp, TestApp } from './support/test-app';

const validEvent = {
  patientId: 'p-1',
  type: 'vitals',
  data: { heartRate: 72 },
  ts: '2026-01-01T10:00:00Z',
};

describe('HTTP API', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());

  beforeEach(async () => {
    t = await createTestApp();
  });

  afterEach(() => t?.close());

  describe('POST /events', () => {
    it('accepts a new event with 202 once it is stored', async () => {
      const res = await http().post('/events').send(validEvent).expect(202);

      expect(res.body).toEqual({ id: expect.any(String), status: EventStatus.Pending, duplicate: false });
      expect(await t.events.findById(res.body.id)).toMatchObject({ patientId: 'p-1', status: EventStatus.Pending });
    });

    it('answers a sender retry with 200 and the original id', async () => {
      const first = await http().post('/events').send(validEvent).expect(202);
      const retry = await http()
        .post('/events')
        .send({ ...validEvent, ts: '2026-01-01T12:00:00+02:00' })
        .expect(200);

      expect(retry.body).toMatchObject({ id: first.body.id, duplicate: true });
      expect(await t.collection.countDocuments()).toBe(1);
    });

    it.each([
      ['missing patientId', { ...validEvent, patientId: undefined }],
      ['empty type', { ...validEvent, type: '' }],
      ['data not an object', { ...validEvent, data: 'hr=72' }],
      ['ts not ISO 8601', { ...validEvent, ts: 'yesterday' }],
      ['ts without timezone', { ...validEvent, ts: '2026-01-01T10:00:00' }],
      ['unknown field', { ...validEvent, priority: 'high' }],
    ])('rejects %s with 400 and stores nothing', async (_case, body) => {
      await http().post('/events').send(body).expect(400);
      expect(await t.collection.countDocuments()).toBe(0);
    });
  });

  describe('GET /events/:id', () => {
    it('returns the stored event and its processing state', async () => {
      const { body } = await http().post('/events').send(validEvent).expect(202);
      const res = await http().get(`/events/${body.id}`).expect(200);
      expect(res.body).toMatchObject({ _id: body.id, status: EventStatus.Pending, attempts: 0 });
    });

    it('returns 404 for an unknown id', async () => {
      await http().get('/events/unknown').expect(404);
    });
  });

  it('GET /stats reports counts per status', async () => {
    await http().post('/events').send(validEvent).expect(202);
    const res = await http().get('/stats').expect(200);
    expect(res.body.counts).toEqual({ pending: 1, processing: 0, completed: 0, failed: 0 });
    expect(res.body.oldestPendingAgeMs).toEqual(expect.any(Number));
  });

  it('GET /health reports ok while MongoDB is reachable', async () => {
    await http().get('/health').expect(200, { status: 'ok' });
  });
});
