import { loadConfig } from '../src/config/app-config';

describe('loadConfig', () => {
  it('uses defaults sized for 1000 events/min at 5s each', () => {
    const { worker } = loadConfig({});
    const capacityPerMinute = (worker.concurrency * 60_000) / worker.processingDelayMs;
    expect(capacityPerMinute).toBeGreaterThanOrEqual(1000);
  });

  it('rejects a lease that could expire during a legitimate external call', () => {
    expect(() => loadConfig({ LEASE_MS: '10000', PROCESSING_TIMEOUT_MS: '15000' })).toThrow(/LEASE_MS/);
  });

  it('rejects malformed numbers instead of falling back silently', () => {
    expect(() => loadConfig({ WORKER_CONCURRENCY: 'many' })).toThrow(/WORKER_CONCURRENCY/);
    expect(() => loadConfig({ PROCESSOR_FAILURE_RATE: '1.5' })).toThrow(/PROCESSOR_FAILURE_RATE/);
  });
});
