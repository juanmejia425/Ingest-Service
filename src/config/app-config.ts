export const APP_CONFIG = Symbol('APP_CONFIG');

export interface WorkerConfig {
  enabled: boolean;
  concurrency: number;
  processingDelayMs: number;
  processingTimeoutMs: number;
  processorFailureRate: number;
  leaseMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  reorderWindowMs: number;
  idlePollMs: number;
  shutdownGraceMs: number;
}

export interface AppConfig {
  port: number;
  mongoUri: string;
  mongoDbName: string;
  worker: WorkerConfig;
}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, fallback: number, min = 0): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`Config ${key} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

function ratio(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!(value >= 0 && value <= 1)) {
    throw new Error(`Config ${key} must be a number between 0 and 1, got "${raw}"`);
  }
  return value;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export function loadConfig(env: Env = process.env): AppConfig {
  const worker: WorkerConfig = {
    enabled: bool(env, 'WORKER_ENABLED', true),
    concurrency: int(env, 'WORKER_CONCURRENCY', 100, 1),
    processingDelayMs: int(env, 'PROCESSING_DELAY_MS', 5_000),
    processingTimeoutMs: int(env, 'PROCESSING_TIMEOUT_MS', 15_000, 1),
    processorFailureRate: ratio(env, 'PROCESSOR_FAILURE_RATE', 0),
    leaseMs: int(env, 'LEASE_MS', 30_000, 1),
    maxAttempts: int(env, 'MAX_ATTEMPTS', 5, 1),
    retryBaseDelayMs: int(env, 'RETRY_BASE_DELAY_MS', 1_000),
    reorderWindowMs: int(env, 'REORDER_WINDOW_MS', 2_000),
    idlePollMs: int(env, 'IDLE_POLL_MS', 500, 1),
    shutdownGraceMs: int(env, 'SHUTDOWN_GRACE_MS', 20_000),
  };

  // Otherwise a second worker could take over an event that is still being processed.
  if (worker.leaseMs <= worker.processingTimeoutMs) {
    throw new Error('LEASE_MS must be greater than PROCESSING_TIMEOUT_MS');
  }

  return {
    port: int(env, 'PORT', 3000, 1),
    mongoUri: env.MONGO_URI ?? 'mongodb://localhost:27017/?directConnection=true',
    mongoDbName: env.MONGO_DB ?? 'ingest',
    worker,
  };
}
