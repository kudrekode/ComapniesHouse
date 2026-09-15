# Cron pipeline: interview notes

## The short explanation

This is a small, database-backed ingestion and enrichment workflow. `scripts/ingest.ts` polls Companies House through `runPipeline`, stores new company rows, and refreshes derived officer data. A database function refreshes an enrichment worklist; `scripts/enrichmentCron.ts` processes a bounded batch and writes scored LinkedIn matches. Supabase holds progress and cached results between runs. There is also an older optional SearchAPI lookup inside `runPipeline`, enabled by `ENABLE_LINKEDIN_LOOKUP`; keep that separate from the queued Serper worker when explaining the design.

It is fair to call `enrichment_queue` a **database-backed worklist** or **proxy queue** for a personal project. It separates ingestion from slower third-party searches, preserves pending work in the database, orders work by score, and caps each run. It is not a full message-queue implementation: workers select `pending` rows without an atomic claim/lease, so overlapping runs could process the same row. The repo also does not include the SQL for `refresh_enrichment_queue`, so describe its caller and purpose without claiming details about its internal SQL.

## Job flow

1. `ingest:loop` runs `ingest:once` and sleeps 300 seconds. The ingestion job acquires a lock in `ingest_state`, reads `last_processed_at`, and searches from two minutes before the saved watermark.
2. `runPipeline` pages through Companies House search results, fetches profiles/officers with bounded concurrency, and keeps active limited companies. Some new-company officer 404s become empty officer lists; a later recent-director backfill can recover them.
3. Ingestion excludes company numbers already in Supabase, deduplicates the batch, and upserts `companies` on `company_number`. It then calls `refresh_enrichment_queue`, updates the watermark after successful work, and removes company rows whose `last_seen_at` is over 24 hours old.
4. Officer IDs are deduplicated. Appointment details are fetched only when the summary/cache is missing or stale (24-hour default); the raw list is stored in `ingest_state` and a compact result in `officer_appointment_summary`.
5. `enrich:once` runs one enrichment batch when invoked. The worker selects up to ten unexpired pending rows by score, makes up to two different search queries for a director's LinkedIn profile, and updates the company and queue row. The repository shows no managed scheduler configuration for this worker.

## Tables used by these jobs

The exact DDL and constraints are not in this repo; these roles are inferred from the TypeScript queries.

| Table | Role in the workflow |
| --- | --- |
| `companies` | Dashboard records keyed/upserted by `company_number`; includes company fields, director details, enrichment output and prior-appointment summary fields. |
| `ingest_state` | Small key/value state store: `last_processed_at`, `ingest_lock`, and `officer_appointments:{officerId}` JSON cache entries. |
| `officer_appointment_summary` | Reusable per-officer summary keyed by `officer_id`; avoids recounting appointments for each company. |
| `enrichment_queue` | Worklist read by the Serper worker; code uses `company_number`, `score`, `enrichment_status`, `searches_attempted`, and expiry timestamps. |
| `profiles`, `user_events` | Dashboard tutorial preference and UI analytics; not part of the ingestion queue. |

`refresh_enrichment_queue` is a Supabase RPC called after company upserts and director backfills. The function definition is absent, so its exact scoring, expiry, and deduplication rules need to be verified from Supabase before making claims about them.

## How duplicate work is reduced

- The job loads known `company_number`s from `companies` and passes them to `runPipeline` as exclusions.
- The current batch is deduplicated by company number, then upserted with `onConflict: "company_number"`. Re-running an overlapping window therefore does not create another company row.
- The two-minute watermark overlap helps avoid missing records at the boundary. It deliberately allows a little re-reading; the known-company exclusion and upsert make that replay safe for company rows.
- Officer IDs are collected into a `Set`. Existing appointment-cache keys and summary timestamps are checked before calling Companies House again.
- The enrichment worklist is refreshed through a database RPC, but queue uniqueness/claiming cannot be confirmed from this repo. Do not claim exactly-once processing.

Relevant code shape:

```ts
const incrementalSinceMs = Math.max(0, lastProcessedAtMs - INGEST_OVERLAP_MS);
const result = await runPipeline({
  since: new Date(sinceMs),
  now: new Date(nowMs),
  excludeCompanyNumbers: knownCompanyNumbers,
});
```

```ts
const payload = dedupeByKey(rows, (row) => row.company_number);
await supabase.from("companies").upsert(payload, {
  onConflict: "company_number",
});
```

## Suggested vertical slice: enrichment worker

This is a strong interview deep dive because it starts from persisted work, calls an external provider, makes a confidence decision, and writes the result back. Keep the boundary clear: ingestion calls `refresh_enrichment_queue`, but that RPC's SQL is not included here, so the repo does not show exactly how candidates enter or are deduplicated in the worklist.

The worker selects up to ten eligible rows by score. The `pending` and attempt filters matter: a row marked `failed` is not automatically picked up again.

```ts
const pending = await supabase
  .from("enrichment_queue")
  .select("company_number, score, searches_attempted, expires_at")
  .eq("enrichment_status", "pending")
  .gt("expires_at", nowIso)
  .or("searches_attempted.is.null,searches_attempted.lt.2")
  .order("score", { ascending: false })
  .limit(BATCH_SIZE); // BATCH_SIZE = 10
```

For each row it searches using the director name, then tries a second, more contextual query only if the first did not yield a match. These are two query variants, not HTTP retries. A candidate must score at least 70 to be accepted as a LinkedIn match; weaker observed candidates can still be saved as diagnostics. `searchSerper` has a 15-second timeout and throws on non-2xx responses; it has no status-aware retry/backoff loop.

On a match, the worker updates `companies` with the LinkedIn URL, confidence, score, and scoring reasons, then marks the worklist item `enriched`. If there is no usable match, it stores diagnostics and marks the item `failed`. If Serper throws, the batch catch also marks the row failed and increments `searches_attempted`. Since the selector only reads `pending`, this is a terminal outcome in the current worker unless something else requeues the row.

### Compare it with ingestion

| Concern | Companies House ingestion | Serper enrichment worker |
| --- | --- | --- |
| Coordination | Inserts a run-specific lock in `ingest_state`, rejects a duplicate-key lock, refreshes a heartbeat (60-second default), and releases the lock in `finally`. | Selects pending rows and updates them later. No atomic claim, lease, or worker lock is visible in this code. Two workers could search the same row. |
| Retry | `CompaniesHouseClient` retries 429, 5xx, and no-response/network errors with rate-limit-aware or exponential backoff. | The two query variants are not retries. A provider error is caught and the row becomes `failed`; there is no transient retry schedule. |
| Replay/idempotency | Uses a two-minute watermark overlap, excludes known company numbers, deduplicates the batch, and upserts `companies` on `company_number`. This makes company writes safe to replay. | It checks whether a LinkedIn result already exists and updates by company number, which helps after a successful write. It does not prevent two concurrent workers from paying for the same search, and exactly-once processing is not guaranteed. |
| Progress | Advances `last_processed_at` only after successful work and prunes rows older than 24 hours. | Stores `searches_attempted` and terminal `enriched`/`failed` status on the worklist row. |

The ingestion lock has an owner (`runId`) and only that owner refreshes or releases it. The enrichment worker has no comparable claim step. A sensible next iteration would atomically claim a row with a short lease, record `next_attempt_at`, and distinguish retryable provider failures (429, 5xx, timeout/network) from permanent failures. That would add recoverability without retrying invalid requests indefinitely.

The lock acquisition relies on a unique `ingest_state.key`: a duplicate insert (`23505`) means another run owns it. Heartbeat and release both match the run ID so one invocation cannot refresh or delete another's lock.

```ts
const { error } = await supabase
  .from("ingest_state")
  .update({ updated_at: nowIso, value: runId })
  .eq("key", LOCK_KEY)
  .eq("value", runId);
```

There is no transaction spanning the company update and queue status update. A successful company write followed by a failed status write is partly recovered by the next run's `has_linkedin` check, which skips another Serper search and marks the queue row enriched. That limits duplicate paid work after a partial success, but it is not exactly-once processing.

Useful ingest code to open alongside the worker:

```ts
const lastProcessedAtMs = await readLastProcessedAtMs();
const incrementalSinceMs = Math.max(0, lastProcessedAtMs - INGEST_OVERLAP_MS);
const sinceMs =
  knownCompanyNumbers.size === 0
    ? Math.max(initialSinceMs, incrementalSinceMs)
    : incrementalSinceMs;
const result = await runPipeline({
  since: new Date(sinceMs),
  now: new Date(nowMs),
  excludeCompanyNumbers: knownCompanyNumbers,
});
```

The shell loop runs ingestion every five minutes, but the repo does not show a managed scheduler for `enrich:once`. For a serverless deployment, preserve the durable watermark/worklist and make each invocation short and replay-safe; add an atomic lease and retry state before allowing overlapping enrichment invocations.

## Retry policy: be precise

| Caller | What it retries | Limit and wait | What happens otherwise |
| --- | --- | --- | --- |
| `CompaniesHouseClient.requestWithRetry` | HTTP 429, HTTP 5xx, and errors with no response (for example, network/timeouts). Other HTTP 4xx fail immediately. | `CH_MAX_RETRIES`, default 6 retries after the first call. Honors numeric `X-RateLimit-Reset` / `Retry-After`; fallback is exponential backoff with jitter, capped at 10 seconds. | Logs `[CH] Retry ... status=... wait_ms=...`; then throws when exhausted. |
| `getCompanyOfficers` | It does **not** retry HTTP 404. | A 404 is treated as temporary missing officer data. | Returns `[]`; a later ingestion pass can backfill recent rows with no directors. Other errors bubble to the pipeline, which logs and continues with no officers for that company. |
| `EnrichmentService` (older optional path) | HTTP 429 and 5xx only. It does not retry 4xx or network errors with no response. | `SEARCH_MAX_RETRIES`, default 4 retries; honors numeric `Retry-After`, otherwise exponential backoff with jitter, capped at 10 seconds. | Throws to its caller. This path uses Axios + SearchAPI, not Serper. |
| `scripts/enrichmentCron.ts` Serper path | No HTTP status retry loop. Any non-2xx response throws; request timeout is 15 seconds. | The “two searches” are query variants, not retry attempts: director name, then director name plus city/company if needed. | The batch catch marks the queue row `failed` and increments `searches_attempted`; failed rows are not selected by the pending-only query, so this is not an automatic transient retry policy. |

The Companies House retry guard is the important distinction:

```ts
if (attempt > this.maxRetries || (status && status < 500 && status !== 429)) {
  throw err;
}
```

That means 429/5xx and missing-status network errors proceed to backoff; ordinary 4xx, including a 404, do not. `getCompanyOfficers` handles 404 separately. TypeScript response generics do not validate JSON at runtime; malformed payloads can currently look like empty `items` rather than a schema failure.

Useful log/error examples: Companies House retry logs include `[CH] Retry ... status=429` (or `status=unknown` for no response). Serper rejects a non-2xx response with `Serper API failed: <status>`; `runCronBatch` then logs `[EnrichmentCron] Failed <company_number>:` and marks that queue row failed. Companies House officer 404 is intentionally converted to `[]`, so it produces no error message at that point. The old SearchAPI retry loop has no per-retry log and ultimately rethrows the original Axios error.

## Sensible critique, without overselling it

For a demo project, this design shows useful separation: durable progress in Supabase, idempotent company writes, cached officer lookups, and a bounded worklist that can be run independently. If taking it further, I would first add server-side runtime validation and meaningful retry states (`retryable`, `failed`, `next_attempt_at`), then atomically claim queue work with a lease so two workers cannot both take the same pending row. I would also expose per-run counts and failures. A serverless version could invoke short, idempotent scheduled jobs while keeping the watermark and worklist in the database; the current infinite shell loop is not itself a serverless scheduler.

## Code to open during the discussion

- [`companiesHouseClient.ts`](../companiesHouseClient.ts): pagination, status classification, backoff, officer 404 behavior.
- [`lib/runPipeline.ts`](../lib/runPipeline.ts): date window, company filtering, concurrency limiter, director extraction.
- [`scripts/ingest.ts`](../scripts/ingest.ts): watermark, lock, deduplication, Supabase writes, appointment cache, retention.
- [`scripts/enrichmentCron.ts`](../scripts/enrichmentCron.ts): pending queue selection, Serper calls, scoring, terminal queue updates.
- [`package.json`](../package.json): `ingest:loop` repeats every five minutes; `enrich:once` invokes one batch.
