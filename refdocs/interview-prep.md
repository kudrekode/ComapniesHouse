# Companies House project: interview prep

For the presentation order, use [`interview-roadmap.md`](interview-roadmap.md). For the concise job/table/retry reference, use [`pipeline-interview-notes.md`](pipeline-interview-notes.md).

## Positioning

Present this as an end-to-end data workflow with a useful user interface: it finds recently incorporated UK companies, enriches company and director details, stores the results, and lets a user filter and inspect them. Be candid that it is a personal project and that parts need production hardening. Lead with the user problem and the decisions you made, then use the code to support the story.

This maps well to the role's emphasis on product workflows, React/TypeScript/Next.js, APIs and data models, reliable backend work, and using AI tools thoughtfully. The task brief explicitly says the interviewer will ask for technical detail, so be ready to explain one slice end to end rather than trying to memorize every component.

A concise opening could be: “I built a small lead-discovery dashboard around newly incorporated UK companies. A scheduled TypeScript pipeline finds candidates through Companies House, adds company and director data, stores it in Supabase, and a Next.js dashboard lets someone filter and inspect the results. I’ll show the user flow first, then trace one company through the system and discuss what I would harden next.”

## The 15–25 minute project walkthrough

1. **Problem and scope (2 minutes).** Explain who might use a feed of new companies and why director history and possible LinkedIn matches could help. State what you built and what remains a prototype; do not invent impact metrics.
2. **Frontend demo (3–5 minutes).** Use the local synthetic demo to explain the intended lead-discovery value, filter by SIC or time window, sort by freshness/confidence, and open a director's appointment history. Say that the demo is fixture-backed and makes no database or third-party calls; the connected data path is what the diagrams show.
3. **Pipeline and data model (4–5 minutes).** Show [`logic_datamodel.mmd`](logic_datamodel.mmd) for the table roles, then [`arch_diagram.mmd`](arch_diagram.mmd) for ingestion, enrichment, and dashboard reads. Explain the watermark, upsert key, officer cache, and worklist. The repository has no SQL DDL/RLS policies, so describe the diagrams as inferred from code and the arrows as logical associations.
4. **One vertical slice (5–7 minutes).** Trace one enrichment candidate through `scripts/enrichmentCron.ts`: queue selection → two possible query variants → scoring → company and queue updates. Contrast it with Companies House retries and the ingest lock/heartbeat. The code excerpts and precise limitations are in [`pipeline-interview-notes.md`](pipeline-interview-notes.md).
5. **Self-review (2–4 minutes).** Pick two or three concrete improvements such as server-side authorization, runtime validation, or atomic queue claims, and explain the risk each addresses.

For the separate experience block, prepare your current work example as a spoken walkthrough because you cannot show code. Explain the problem, your contribution, the technical shape at a safe level, a decision you made, and the outcome or lesson. For AI tooling, give one specific example of how you used it and verified its output; this project does not need to be an AI product.

You do not need to know every styling component deeply. Know the enrichment slice well, be ready to explain that `/api/run` is a read endpoint rather than the ingestion job, and keep a clear map of auth and caching responsibilities.

## Diagrams after the demo

Use [`logic_datamodel.mmd`](logic_datamodel.mmd) as the table map and [`arch_diagram.mmd`](arch_diagram.mmd) as the lifecycle view. The main explanation is: `companies` is the dashboard/read model; `ingest_state` stores progress, locking, and raw appointment cache entries; `officer_appointment_summary` stores compact derived data; and `enrichment_queue` is a persisted worklist. `directors_detail` contains officer IDs as serialized JSON, not a normalized join table. The table links in the diagram are inferred from application code; confirm SQL constraints before calling them foreign keys.

## Details to know well

- **Companies House pagination:** in [`companiesHouseClient.ts`](../companiesHouseClient.ts), `start_index` is an offset, not a page number. The search method asks for up to 100 results at a time and advances the offset; officers and appointments use `items_per_page: 100` plus `start_index`. Separately, the dashboard's `page` is a 1-based UI page, translated to Supabase `.range(from, to)` with a default page size of 200 (maximum 500).
- **Pipeline scope and concurrency:** [`lib/runPipeline.ts`](../lib/runPipeline.ts) defaults to a 24-hour lookback, requests up to `MAX_COMPANIES_TO_CHECK` search results (default 250), filters profiles to active `ltd` companies, and applies `MAX_COMPANIES` as a later output cap. The in-memory limiter bounds simultaneous profile and officer calls; default concurrency is four.
- **Companies House retries:** `CH_MAX_RETRIES` defaults to six retries after the initial call. The client retries 429 and 5xx responses, and errors without an HTTP response; it fails other 4xx responses. It honors numeric `Retry-After` and Companies House's `X-RateLimit-Reset`, otherwise uses exponential backoff with jitter and a 10-second cap. The officer-list method converts a 404 to an empty list because newly created companies can have officers data lag behind. That avoids failing the batch, but currently makes “not available yet” indistinguishable from “no officers”; [`scripts/ingest.ts`](../scripts/ingest.ts) later retries recovery for recent rows with no directors.
- **Incremental ingestion:** [`scripts/ingest.ts`](../scripts/ingest.ts) reads `last_processed_at`, overlaps the next search window by two minutes, excludes company numbers already in Supabase, upserts by company number, prunes company rows older than 24 hours, then advances the watermark. It also records an ingest lock and refreshes its heartbeat. `ingest:loop` is a shell loop that invokes the one-shot job every five minutes; the repo does not show a managed production scheduler.
- **What `/api/run` means:** despite its name, [`app/api/run/route.ts`](../app/api/run/route.ts) does not run `runPipeline`. It is the dashboard's read endpoint: it applies filters and pagination to rows already in Supabase. The ingestion work is started by `scripts/ingest.ts`.
- **Two distinct enrichment implementations:** [`enrichmentService.ts`](../enrichmentService.ts) is the older optional lookup, using Axios and SearchAPI (`searchapi.io`) to search a company name. Its retry loop retries 429/5xx, with four retries by default. The queue worker in [`scripts/enrichmentCron.ts`](../scripts/enrichmentCron.ts) uses `fetch` and Serper to search for a director's LinkedIn profile. Its two searches are different query variants (name alone, then name plus city/company), not two HTTP retries. `searchSerper` has a timeout but no status-based retry loop; errors are caught by the batch and the queue row is marked failed.
- **Storage, pagination, and caching:** company records live in Supabase, not browser local storage. The Supabase browser client uses the SDK's default persistent auth session, which is stored in local storage ([Supabase JS auth docs](https://supabase.com/docs/reference/javascript/auth)); the app itself does not persist company rows there. The dashboard fetches one 200-row page at a time (the API allows up to 500), and the page has no component-level lazy loading or virtualization. The route caches each query shape for five minutes; the browser polls it every five minutes. Raw officer appointments are JSON values in `ingest_state`, with a 24-hour refresh policy in the background job. No Companies House calls happen when the appointments modal opens; it reads that cache.
- **Metric naming issue:** the API's `enrichedToday` count is based on `first_seen_at` falling today, so it counts new rows, not necessarily completed enrichment jobs. LinkedIn matches are counted from that same cohort. I would rename or redefine the metric so the label and measurement match.
- **API security:** the dashboard checks its Supabase session in the browser and redirects to `/login`, but `GET /api/run` and the appointments endpoint do not verify that session server-side. The appointments endpoint returns cached data for any officer ID. The server admin client uses a service-role/secret key, which [bypasses Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), so protect these endpoints with a server-verified session before sharing the deployment; a client-side redirect does not protect API data.

## A fair self-review

Start with an improvement tied to a real failure mode, then describe the specific change:

- Validate external API responses at runtime (for example, with Zod) instead of relying on TypeScript generics, which do not validate JSON at runtime. Distinguish schema-invalid responses from transient HTTP failures and only retry failures that can plausibly recover.
- Add tests around date-window filtering, pagination boundaries, transient 404 behavior, retry classification, and enrichment candidate scoring. The current `npm test` script is only a placeholder.
- Move from the shell loop to short, idempotent scheduled invocations or a durable queue as the deployment requires. Preserve the watermark and overlap; make lock acquisition atomic if runs can overlap; add visible job outcomes and a dead-letter/retry policy.
- Add server-side authorization to the API routes and review the Supabase RLS rules. For sector filtering, the route currently fetches the full filtered result set and applies sector selection in memory before slicing a page, which will become expensive as the table grows.
- Simplify the old and new enrichment paths into one documented provider/worker path so configuration and retry behavior are clear.

## Demo recommendation

Use the local demo path for the interview: with no public Supabase configuration in development, it opens without login and generates 75 synthetic rows in the browser. Filtering, sorting, pagination, exports, and the prior-appointments modal use local data; outbound links are disabled. You can force it with `NEXT_PUBLIC_DEMO_MODE=true`. Explain that this is a presentation fixture, while the table and lifecycle diagrams describe the Supabase-backed application path. Keep production deployments on the authenticated mode unless demo mode is deliberately enabled.

## Useful interviewer questions

- You have been building Worldmaker from early on. Which early architecture or product assumptions changed most as customers started using it?
- How do you decide whether a customer workflow belongs in configurable product behavior, a bespoke feature, or an agentic workflow?
- Where do you currently spend the most engineering effort on reliability: integrations, background jobs, data quality, or the user-facing workflow?
- What does good AI-assisted development look like on this team, and how do you review and test changes produced with agents?
- What would you hope the person in this role had shipped or learned after their first three months?

## Axios note

The committed lockfile pins Axios 1.13.4, even though `package.json` allows later 1.x versions. GitHub's reviewed [GHSA-43fc-jf86-j433](https://github.com/advisories/GHSA-43fc-jf86-j433) lists versions through 1.13.4 as affected by a denial-of-service bug and 1.13.5 as patched. A later reviewed [GHSA-gcfj-64vw-6mp9](https://github.com/axios/axios/security/advisories/GHSA-gcfj-64vw-6mp9) lists 1.15.2 through versions before 1.18.0 as affected in a prototype-pollution scenario. That makes dependency updating and lockfile-based auditing fair critique points. I do not see evidence that either issue explains a normal startup/build failure here: the vulnerable behaviors need particular attacker-controlled configuration/prototype conditions, while these calls use fixed Axios options. Diagnose a run failure from the actual error and environment rather than blaming Axios by default.
