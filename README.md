# Ingest Service

Accepts patient events over HTTP, processes each through a slow (~5 s) external system, and stores the outcome in a single MongoDB collection. Built with NestJS and MongoDB.

## Running it

```bash
docker compose up --build        # MongoDB (single-node replica set) + the service on :3000
```

```bash
curl -i -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"patientId":"p-1","type":"vitals","data":{"hr":72},"ts":"2026-01-01T10:00:00Z"}'
# HTTP/1.1 202 Accepted   {"id":"<sha256>","status":"pending","duplicate":false}
# Send it again:  HTTP/1.1 200 OK   {"id":"<same sha256>","status":"...","duplicate":true}

curl localhost:3000/events/<id>  # state and outcome of one event
curl localhost:3000/stats        # counts per status, backlog age, retries, late arrivals
curl localhost:3000/health
```

Tests (use an in-memory MongoDB replica set, nothing else needed):

```bash
npm install
npm test
```

## Seeing that it holds up

Two scripts reproduce the conditions in the brief against the running stack and then check the result.

```bash
npm install
docker compose up --build -d

# Terminal 1: 1000 events/min for 2 minutes. Events arrive out of ts order, ~10% are
# delivered twice, and failed or timed-out requests are retried until acknowledged.
npm run load-test

# Terminal 2, at the same time (optional): SIGKILL the service 4 times mid-run.
./scripts/chaos.sh 4

# When the load test finishes: wait for the backlog to drain, then check the guarantees.
npm run verify
```

`verify` compares the acknowledged ids with the database. This is an actual run: 2000 events at 1000/min, about 10% delivered twice, a 5% flaky downstream (`PROCESSOR_FAILURE_RATE=0.05`), and the service SIGKILLed 3 times during the run:

```
[done] unique=2000 accepted=2000 duplicateAcks=195 retries=552 rejected=0 ackLatency p50=8ms p99=25ms

Run f2219341: 2000 acknowledged, 2000 stored

PASS  every acknowledged event is stored — 0 missing
PASS  one document per distinct event — 2000 documents
PASS  every event reached a final state — 0 still open
PASS  no event failed permanently — 0 failed
PASS  per-patient ts order respected (late arrivals flagged) — 31 late arrivals flagged
INFO  321 events needed more than one attempt (retries or takeovers after a crash)
```

The 552 `retries` are sender requests that failed while the service was down; they were redelivered until acknowledged. The 31 late arrivals are events whose delivery was held up by those outages long enough that a later event of the same patient had already been applied. They are processed, and flagged as late.

To exercise the retry path as well, run with a flaky downstream: `PROCESSOR_FAILURE_RATE=0.2 docker compose up -d`.

## Architecture

```
 sender ──POST /events──▶ EventsController ──insertOne (w:majority, j:true)──▶ ┌──────────────┐
        ◀── 202 / 200 ───                                                        │    events    │
                                                                                 │  collection  │
 EventWorker (N per instance, any number of instances)                           │              │
   dispatcher ──claimNext (atomic findOneAndUpdate + lease)────────────────────▶ │ pending      │
   handle()   ──ExternalProcessor.process (~5 s, timeout, retry/backoff)         │ processing   │
              ──complete / fail (fenced by owner + attempt)────────────────────▶ │ completed    │
                                                                                 │ failed       │
                                                                                 └──────────────┘
```

There is a single collection, `events`. It holds each event's state, which makes it the durable queue, and its outcome, which makes it the record the rest of the platform reads. There is no broker. MongoDB already has the guarantees needed (atomic single-document updates, unique and partial indexes, majority writes), and the brief asks for one collection.

| Path | Responsibility |
|---|---|
| `src/events/events.controller.ts` | HTTP API: validate, store, acknowledge |
| `src/events/events.repository.ts` | All MongoDB access; claiming, leases, fencing, indexes. This is where the guarantees live. |
| `src/events/event-id.ts` | Content-derived event id (deduplication) |
| `src/processing/event-worker.service.ts` | Dispatch loop, retries, graceful shutdown |
| `src/processing/external-processor.ts` | The slow downstream system (simulated) and its contract |
| `src/config/app-config.ts` | Typed, validated configuration from the environment |

### Event lifecycle

`pending` → `processing` (claimed with a lease) → `completed` | `failed`.
Documents are never deleted. A `failed` event stays visible with its `lastError` and can be replayed by setting it back to `pending`.

## Decisions, by operating condition

### "A sender must get an answer immediately"
`POST /events` only validates and inserts, then returns `202`. Processing happens asynchronously in the worker. The sender waits a few milliseconds, never the 5 s of processing.

### "An event may never be silently lost" + "restarts at arbitrary moments"
- **Persist before acknowledging.** The insert uses `w: majority, journal: true`. An event we answered `202` for survives a process crash, a node crash and a primary failover. If MongoDB is unavailable, the request fails with `5xx`, the sender retries, and nothing has been acknowledged that we do not have.
- **No in-memory queue.** A killed process loses nothing it held in memory, because it held nothing. All work state is in the document.
- **Leases.** A worker claims an event by atomically setting `status: processing`, `lockedBy` and `leaseExpiresAt`. If the worker dies, the lease expires (30 s) and any instance takes the event over (`reclaimExpired`).
- **Graceful shutdown.** On SIGTERM the worker stops claiming and drains in-flight events for up to `SHUTDOWN_GRACE_MS`. A hard kill is also safe, it only recovers more slowly (after lease expiry).
- **Nothing disappears into retries.** Transient downstream failures are retried with exponential backoff. After `MAX_ATTEMPTS` the event becomes `failed` and stays visible in `/stats` and in the collection. It is parked, not dropped.

### "Never counted twice" + "senders retry and send duplicates"
- **Idempotent ingest.** Senders give us no event id, so `_id` is a SHA-256 of the event's canonical content: keys sorted, `ts` normalised to UTC ISO. A redelivery collides on `_id`, is not stored again, and gets `200` with the original id and its current status. Because `_id` is deterministic, the driver's retryable writes are safe as well.
- **One processing run per event at a time.** The claim is an atomic `findOneAndUpdate`, so two workers cannot claim the same event.
- **Fencing.** `complete`, `fail` and `beginRetry` only apply if `lockedBy` and `attempts` still match the claim. A worker that stalled past its lease and was replaced (GC pause, network partition) cannot overwrite the new owner's result. This is tested.

### "The end result depends on the sequence of a patient's events"
- **One in-flight event per patient, enforced by MongoDB.** A partial unique index on `patientId` where `status = processing` makes a second concurrent claim for the same patient fail with a duplicate-key error. This holds across all workers and all instances, with no in-process coordination and no extra lock collection.
- **Claim in `ts` order.** Workers claim the pending event with the smallest `ts` among patients with nothing in flight. Because the sort is global, that event is also the earliest of its own patient.
- **Retries keep their place.** A retried event keeps its claim during backoff, so a later event of that patient cannot overtake it.

### "Nothing guarantees arrival order"
Arrival order and `ts` order differ in two cases, and they are handled differently:
1. **The earlier event arrives while the later one is still waiting.** This is the normal case under load, because events wait in the backlog. It is fully reordered by the `ts` sort.
2. **The earlier event arrives after the later one was already applied.** The external call cannot be undone. A short **reorder window** (`REORDER_WINDOW_MS`, 2 s) makes events claimable only once they are slightly old, which absorbs most network-level reordering. Anything later is still processed, because dropping clinical data is worse, but it is stored with `lateArrival: true` and logged so downstream consumers can reconcile. It is not silently mixed in.

### "1000 events/min, for hours, and growing"
- 1000/min × 5 s means ~84 events must be in flight at all times. Each instance runs `WORKER_CONCURRENCY` (default 100) concurrent slots: 100 × 60 / 5 = **1200/min per instance**. The work is I/O-bound waiting, so one Node process handles this easily. A test pins this sizing.
- **Horizontal scaling** needs no code change: run more instances. All coordination is in MongoDB. Ingest-only and worker-only nodes are possible (`WORKER_ENABLED=false`).
- Backpressure: if input outpaces processing, events simply wait in `pending`. They are durable, so a backlog is a latency problem, not a data-loss problem. `/stats.oldestPendingAgeMs` is the signal to alert or autoscale on.
- Indexes back every hot query: claim (`status, ts`), lease recovery (`status, leaseExpiresAt`), late-arrival check (`patientId, ts`).

## Trade-offs I accepted

- **Downstream calls are at-least-once, not exactly-once.** If a worker dies after the external call returns but before `complete` is written, the event is processed again after lease expiry. No storage design can avoid this without the downstream's cooperation. The recorded outcome is still written exactly once (fencing), and the event id is passed to the processor as an idempotency key. The `ExternalProcessor` contract documents that it must honour it.
- **Content-based deduplication.** Two genuinely distinct events with byte-identical `patientId`, `type`, `ts` and `data` collapse into one. With a millisecond `ts` that is practically indistinguishable from a redelivery, and a sender-supplied event id would be better (see below). In the other direction, a sender that changes the payload on retry (for example by adding a field) produces a new event.
- **A permanently failing event does not block its patient forever.** After `MAX_ATTEMPTS` it is parked as `failed` and the patient's later events continue. The alternative, halting the patient's stream until a human intervenes, keeps strict order but stops all of that patient's data. I chose to keep data flowing and make the failure loud. This is a product decision that should be confirmed with clinical stakeholders.
- **Per-patient throughput is capped** at one event per ~5 s (12/min per patient). That is the price of strict per-patient ordering against a slow downstream. Throughput across patients is unaffected.
- **Polling instead of push.** An idle dispatcher polls every 500 ms (one cheap indexed query per instance). Change streams would cut the latency but add resume-token handling. Under the stated sustained load the dispatcher is never idle anyway.
- **Claiming reads the busy-patient list** (`distinct` on the partial index, so it is about as large as the in-flight count) to avoid repeatedly picking blocked patients. It is an optimisation only; correctness comes from the unique index. At very large scale (thousands of instances) a hash-partitioned claim would scale better.
- **Unknown fields are rejected (`400`)**, not stripped. Silently dropping part of a clinical event is worse than a loud error the sender's integration team will see.
- **A timeout does not cancel the external call.** The worker stops waiting after `PROCESSING_TIMEOUT_MS` and retries, while the abandoned call may still complete downstream. That is safe only because of the idempotency-key contract. A real client should be passed an `AbortSignal`.

## What I would do with more time

1. **Accept a sender-provided `eventId` / `Idempotency-Key`** and prefer it over the content hash. This is more precise, and it lets a sender correct a payload.
2. **Observability**: Prometheus metrics (ingest rate, ack latency, backlog age, in-flight count, retries, failures, late arrivals), structured JSON logs with event id and patient id, and alerts on `oldestPendingAgeMs` and `failed > 0`.
3. **Operator tooling** for `failed` events: an endpoint or CLI to inspect and replay them, and a per-patient view.
4. **Change streams** to wake idle workers immediately, with polling kept as the fallback.
5. **Rate limiting / admission control** per sender, so one misbehaving integration cannot fill the backlog for everyone.
6. **Retention / archiving** of completed events (TTL into cold storage). The collection grows by about 1.4 M documents per day at today's volume.
7. **A real downstream client** with an `AbortSignal`, a circuit breaker, and a concurrency limit that matches the downstream's capacity rather than ours.
8. **Load test in CI** with chaos (the scripts exist; wire them into a pipeline with a time budget).

## Configuration

All settings are optional environment variables, validated at startup (see `.env.example` and `src/config/app-config.ts`).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | HTTP port |
| `MONGO_URI` / `MONGO_DB` | `mongodb://localhost:27017/?directConnection=true` / `ingest` | Database |
| `WORKER_ENABLED` | true | Run the processing worker in this instance |
| `WORKER_CONCURRENCY` | 100 | In-flight events per instance |
| `PROCESSING_DELAY_MS` | 5000 | Simulated downstream latency |
| `PROCESSING_TIMEOUT_MS` | 15000 | Abandon a downstream call after this |
| `PROCESSOR_FAILURE_RATE` | 0 | Simulated downstream failure probability |
| `LEASE_MS` | 30000 | Claim lifetime; must exceed `PROCESSING_TIMEOUT_MS` |
| `MAX_ATTEMPTS` | 5 | Attempts before an event is parked as `failed` |
| `RETRY_BASE_DELAY_MS` | 1000 | Exponential backoff base (capped at 60 s) |
| `REORDER_WINDOW_MS` | 2000 | Minimum age before an event is claimable |
| `IDLE_POLL_MS` | 500 | Dispatcher poll interval when idle |
| `SHUTDOWN_GRACE_MS` | 20000 | Drain time on SIGTERM |

## Tests

They focus on what is risky, against a real MongoDB, because the guarantees live in indexes and atomic updates that a mock would not exercise:

- `events.repository.spec.ts`: deduplication under concurrent inserts, `ts`-ordered claiming, one in-flight event per patient under 20 concurrent claimers, the reorder window, lease takeover with fencing of the old owner, the patient staying blocked during a retry, late-arrival detection.
- `event-worker.spec.ts`: end to end with out-of-order and duplicate input (each event processed exactly once, each patient in order), retry then success, retry exhaustion → `failed`, an event that keeps crashing its workers, late-arrival flagging, draining on shutdown.
- `events.http.spec.ts`: `202`/`200` semantics, validation (including timezone-less timestamps and unknown fields), lookup, stats, health.
- `event-id.spec.ts`, `app-config.spec.ts`: canonicalisation and config validation, including the lease/timeout invariant and the capacity sizing.
