# Architecture evidence and boundaries

This document separates behavior directly visible in the repository from behavior that depends on missing database infrastructure. It describes the connected Supabase implementation as historical architecture and the synthetic application as the current reproducible demo.

## Evidence classification

### Directly verified in code

- Companies House advanced search, profile, officer, and appointment calls.
- Pagination using `start_index` and bounded in-process concurrency.
- Retry/backoff for Companies House 429, 5xx, and network/no-response failures.
- Filtering to active `ltd` company profiles.
- A persisted ingestion watermark and two-minute overlap.
- A run lock with owner UUID, TTL cleanup, heartbeat, and owner-checked release.
- Known-company exclusion, per-batch deduplication, and company upsert on `company_number`.
- Raw officer appointment caching and summary upsert on `officer_id`.
- A call to the `refresh_enrichment_queue` Supabase RPC after relevant company updates.
- Selection of pending, unexpired enrichment rows with fewer than two recorded searches.
- Score-ordered batches of at most ten queue rows.
- Serper candidate scoring and separate company/queue write-back.
- Terminal `enriched` and `failed` outcomes.
- Existing-result detection that avoids another search after one partial-write scenario.
- Five-minute dashboard response caching and five-minute browser polling in connected mode.
- A deterministic, credential-free synthetic demo that bypasses connected services.

### Inferred but not database-verified

- `company_number` must be unique for `upsert(..., { onConflict: "company_number" })` to behave as intended.
- `ingest_state.key` must be unique for duplicate error `23505` to coordinate the run lock.
- `officer_appointment_summary.officer_id` must be unique for its upsert conflict target.
- `first_seen_at` appears to require a database default or trigger because the ingest payload does not set it.
- Logical associations between company, queue, officer, profile, and event records are visible, but foreign keys are not.

### Missing and not reproducible from this repository

- Table DDL, indexes, unique constraints, and foreign keys.
- Supabase migrations and seed data.
- Row-level security policies.
- The `refresh_enrichment_queue` function body, including candidate scoring, expiry, and deduplication.
- Any database trigger or default that initializes `first_seen_at`.
- Production scheduling for ingestion or enrichment.
- Observability configuration and operational dashboards.

### Explicitly not implemented in the visible worker

- A `processing` queue state.
- Atomic row claim, lease, or visibility timeout.
- Exactly-once enrichment.
- Automatic retry/backoff for Serper failures.
- Dead-letter processing.
- A transaction spanning the company update and queue-status update.

## Connected architecture

```mermaid
flowchart TB
    subgraph Scheduling[Invocation]
        Loop[npm run ingest:loop]
        External[External scheduler not included]
    end

    subgraph Ingestion[Incremental ingestion]
        Job[scripts/ingest.ts]
        Pipeline[lib/runPipeline.ts]
        CHClient[CompaniesHouseClient]
    end

    subgraph ExternalAPIs[External APIs]
        CH[Companies House API]
        Search[Serper search API]
    end

    subgraph Postgres[Supabase / Postgres - definitions missing]
        State[(ingest_state)]
        Companies[(companies)]
        OfficerSummary[(officer_appointment_summary)]
        Refresh[refresh_enrichment_queue RPC]
        Queue[(enrichment_queue)]
    end

    subgraph Enrichment[Asynchronous enrichment]
        Worker[scripts/enrichmentCron.ts]
    end

    subgraph Application[Connected application]
        API[Next.js read routes]
        UI[Dashboard]
    end

    Loop --> Job
    External -. possible invocation .-> Job
    External -. possible invocation .-> Worker
    Job <-->|lock, heartbeat, watermark, appointment cache| State
    Job --> Pipeline
    Pipeline --> CHClient
    CHClient <--> CH
    Pipeline --> Job
    Job -->|dedupe and upsert by company_number| Companies
    Job <-->|read and upsert by officer_id| OfficerSummary
    Job -->|call; implementation absent| Refresh
    Refresh --> Queue
    Queue -->|pending and unexpired, max 10| Worker
    Worker <--> Search
    Worker -->|match and diagnostics| Companies
    Worker -->|enriched or failed| Queue
    Companies --> API
    State --> API
    API --> UI
```

`npm run ingest:loop` is a shell loop, not evidence of a managed production scheduler. `npm run enrich:once` performs a single batch; no repository configuration schedules it.

## Current demo architecture

```mermaid
flowchart TB
    Start[npm run dev or npm run build] --> Next[Next.js application]
    Fixtures[lib/demoData.ts] -->|75 deterministic rows| Next
    Next --> Local[In-memory filter, sort, and pagination]
    Local --> Dashboard[Dashboard table and summaries]
    Dashboard --> Export[CSV / JSON / XML generated in browser]
    Dashboard --> History[Synthetic appointment history]

    Bypass[No Supabase, auth, API routes, Companies House, Serper, or SearchAPI]
    Bypass -. boundary .-> Next
```

The demo is enabled unless `NEXT_PUBLIC_DEMO_MODE=false` is set explicitly. It contains no live company records or outbound profile URLs.

## Logical data model

The following diagram shows application-level associations. It must not be read as verified SQL or foreign-key DDL.

```mermaid
erDiagram
    COMPANIES {
        string company_number "upsert conflict target"
        string company_name
        string directors_detail "serialized JSON"
        datetime first_seen_at "database initialization not shown"
        datetime last_seen_at
        boolean has_linkedin
        string linkedin_url
    }

    INGEST_STATE {
        string key "watermark, lock, or cache key"
        string value
        datetime updated_at
    }

    OFFICER_APPOINTMENT_SUMMARY {
        string officer_id "upsert conflict target"
        boolean has_previous_appointments
        int previous_distinct_companies
        datetime updated_at
    }

    ENRICHMENT_QUEUE {
        string company_number "lookup key"
        number score
        string enrichment_status
        int searches_attempted
        datetime expires_at
    }

    COMPANIES ||--o| ENRICHMENT_QUEUE : "logical company_number association"
    COMPANIES }o--o{ OFFICER_APPOINTMENT_SUMMARY : "officer IDs stored in JSON"
```

`ingest_state` is intentionally separate in the diagram because its relationship is by conventional key names rather than a visible relational association.

## Ingestion lifecycle

```mermaid
stateDiagram-v2
    [*] --> AcquireLock
    AcquireLock --> Skipped: duplicate lock key
    AcquireLock --> ReadWatermark: lock acquired
    ReadWatermark --> Discover: subtract two-minute overlap
    Discover --> Normalize: profiles and officers fetched
    Normalize --> Upsert: dedupe by company_number
    Upsert --> RefreshWorklist: call missing RPC
    RefreshWorklist --> Backfill: officer and recent-director refresh
    Backfill --> Prune: delete companies not seen for 24 hours
    Prune --> AdvanceWatermark
    AdvanceWatermark --> ReleaseLock
    ReleaseLock --> [*]
    Skipped --> [*]

    Discover --> ReleaseAfterError: unhandled failure
    Normalize --> ReleaseAfterError: unhandled failure
    Upsert --> ReleaseAfterError: unhandled failure
    RefreshWorklist --> ReleaseAfterError: unhandled failure
    Backfill --> ReleaseAfterError: unhandled failure
    Prune --> ReleaseAfterError: unhandled failure
    ReleaseAfterError --> [*]: watermark not advanced
```

Individual profile, officer-summary, and director-backfill failures are sometimes logged and skipped so other records can progress. An unhandled run-level error releases the lock in `finally` and prevents the final watermark update, allowing the overlapped window to be replayed.

## Enrichment lifecycle and concurrency gap

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Enriched: accepted candidate
    Pending --> Enriched: company already has a result
    Pending --> Failed: no accepted candidate
    Pending --> Failed: company missing
    Pending --> Failed: provider or processing error
    Enriched --> [*]
    Failed --> [*]

    note right of Pending
      Selection does not change status.
      Concurrent workers can select the same row.
    end note
```

The queue query checks `searches_attempted < 2`, but an exception is recorded as `failed`, and subsequent selection only reads `pending`. There is no visible scheduled retry of failed work.

## Failure and recovery behavior

### Companies House

The client retries 429, 5xx, and failures without an HTTP response. It prefers `X-RateLimit-Reset`, then numeric `Retry-After`, then exponential backoff with jitter capped at ten seconds. Other 4xx responses fail immediately. Officer-list 404 responses are treated as an empty list so a newly registered company does not fail the entire run; a later recent-director backfill can recover some delayed data.

### Officer cache

Raw appointment lists are stored under `officer_appointments:{officerId}` keys in `ingest_state`. Compact counts are upserted in `officer_appointment_summary`. Missing or stale data is refreshed with bounded concurrency and a configurable per-run cap.

### Enrichment worker

Serper requests have a 15-second timeout but no status-aware retry loop. Weak or disqualified candidates can be stored as diagnostics before the queue row is marked failed.

### Partial write

The worker writes `companies` first and updates `enrichment_queue` second. If only the first write succeeds, the next run's existing-result check can mark the row enriched without repeating the external search. Other cross-table inconsistencies are not transactionally prevented.

## Connected-mode security boundary

The browser verifies a Supabase session before showing the connected dashboard. The retained API routes do not verify that session server-side and use an admin/service-role client. Connected mode should therefore not be exposed publicly until server-side authorization and the missing RLS policy review are completed.

