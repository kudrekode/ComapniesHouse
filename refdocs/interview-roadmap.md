# Interview prep roadmap

The project walkthrough is 15–25 minutes. Keep the narrative to the product, its persisted data path, and one technical slice; the second work example is a separate 15–20-minute discussion and must stay code-free.

## Companies House project: aim for about 20 minutes

### 1. Problem and product demo — 5 minutes

Frame the product as a prototype for finding recently incorporated UK companies and helping someone qualify them for early outreach. The business hypothesis is that company details, director history, and possible LinkedIn matches reduce manual research; do not claim customer impact or conversion metrics you did not measure.

Run the local dashboard at `/`. It uses 75 synthetic companies and makes no database or external API calls; ten rows have enrichment scores and five pass the demo's match threshold. Say that plainly, then show the intended connected design: production rows and job state are persisted in Supabase. A good short path is:

1. Point out the company feed and the intended lead-qualification signals.
2. Filter by SIC or time window, then sort by freshness or confidence.
3. Open a director's previous appointments and explain why it could help qualify a lead.
4. Show a scored candidate and a no-match row; explain that the sample is synthetic and the outbound links are disabled.

Avoid narrating every control or styling detail. Explain what decision the filters help the user make.

### 2. Supabase tables and lifecycle — 5 minutes

Show [`logic_datamodel.mmd`](logic_datamodel.mmd) first for the table roles, then [`arch_diagram.mmd`](arch_diagram.mmd) for how data moves. Be explicit that the table map is inferred from TypeScript because the repository does not include the SQL DDL or RLS policies. Dotted links are logical associations, not verified foreign keys.

Keep the table explanation short:

- `companies` is the dashboard record, written using `company_number` as the upsert conflict target.
- `ingest_state` holds the ingestion watermark and lock, plus raw officer-appointment responses.
- `officer_appointment_summary` stores the compact per-officer result used for company-level filters.
- `enrichment_queue` separates slower Serper work from ingestion; call it a database-backed worklist, not a full queue service.
- `profiles` and `user_events` support the dashboard and sit outside the core pipeline.

### 3. Vertical slice: one enrichment candidate — 6 minutes

Offer to trace one company from queue selection to a scored result in [`scripts/enrichmentCron.ts`](../scripts/enrichmentCron.ts). Use [`pipeline-interview-notes.md`](pipeline-interview-notes.md) for the short code snippets. The slice is:

1. Ingestion upserts companies, then calls `refresh_enrichment_queue`; the RPC implementation is not in this repository.
2. The worker selects a bounded batch of unexpired `pending` rows with fewer than two searches, ordered by score.
3. It tries a director-name LinkedIn query, then a city/company-context query if needed. Those are query variants, not HTTP retries.
4. It accepts matches at score 70 or higher, updates `companies`, and marks the worklist row `enriched`; otherwise it saves diagnostics and marks the row `failed` with searches attempted.

Use the comparison with ingestion to show judgment: Companies House calls have status-aware retry/backoff, and ingestion has a run lock, heartbeat, watermark overlap, and company-number upserts. The Serper worker has a timeout but no HTTP status retry loop or atomic claim/lease. A failed row is marked `failed`, so the pending-only selector will not retry it automatically. Two concurrent workers could also select the same row. Be clear that company writes are idempotent through the upsert key, while queue processing is not guaranteed exactly once.

If asked what you would change, propose retryable versus terminal failures, `next_attempt_at`, bounded exponential backoff, and an atomic lease/claim. Explain the failure each change addresses; do not present them as features the current code already has.

### 4. Self-review — 2–4 minutes

Choose two improvements that you can explain concretely: server-verified authorization on the API routes, runtime validation for external API payloads, and/or atomic queue claims with transient retry states. Avoid turning this into a list of every possible refactor.

## Second block: current work example, no code

Prepare one spoken example from your current role. Cover the user/business problem, your contribution, the system boundary at a safe level, one difficult decision, how you checked the result, and what changed or what you learned. State what you owned versus what the wider team delivered. Do not show confidential code or data.

## Final questions

Choose three and use the ones that fit the conversation:

- Which product or architecture assumptions changed most as Worldmaker moved from inception to customer use?
- How do you decide which workflows should be configurable, custom-built, or handled by an agentic workflow?
- What does good review and testing look like for AI-assisted changes on the team?
- Where does the team currently spend the most effort on reliability: integrations, background jobs, data quality, or user-facing workflows?

## Lightweight preparation order

1. Run the local demo once and rehearse the four-step product path.
2. Rehearse the table roles from `logic_datamodel.mmd` without reading every column aloud.
3. Trace one enrichment row in `scripts/enrichmentCron.ts`, then compare its failure handling with Companies House retries and the ingestion lock.
4. Prepare the current-work example without code and select three interviewer questions.
