import nextEnv from "@next/env";
import { runPipeline } from "../lib/runPipeline.js";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin.js";
import { CompaniesHouseClient } from "../companiesHouseClient.js";
import type { PipelineRow, DirectorDetail } from "../lib/runPipeline.js";
import type { OfficerAppointmentItem } from "../companiesHouseClient.js";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const INGEST_OVERLAP_MS = 2 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const STATE_KEY = "last_processed_at";
const BOOTSTRAP_MINUTES = Number.parseInt(
  process.env.INGEST_BOOTSTRAP_MINUTES || "5",
  10
);
const INITIAL_BACKFILL_HOURS = Number.parseInt(
  process.env.INGEST_INITIAL_BACKFILL_HOURS || "5",
  10
);
const OFFICER_CACHE_TTL_HOURS = Number.parseInt(
  process.env.OFFICER_CACHE_TTL_HOURS || "24",
  10
);
const OFFICER_ENRICH_CONCURRENCY = Number.parseInt(
  process.env.OFFICER_ENRICH_CONCURRENCY || "3",
  10
);
const OFFICER_ENRICH_MAX_PER_RUN = Number.parseInt(
  process.env.OFFICER_ENRICH_MAX_PER_RUN || "200",
  10
);
const SUMMARY_BACKFILL_COMPANY_LIMIT = Number.parseInt(
  process.env.SUMMARY_BACKFILL_COMPANY_LIMIT || "500",
  10
);

type OfficerSummary = {
  officer_id: string;
  has_previous_appointments: boolean;
  previous_distinct_companies: number;
  updated_at: string;
};

type AppointmentCacheRow = {
  key: string;
  value: string;
  updated_at: string;
};

type RowWithDirectorsDetail = {
  directors_detail?: string | null;
};

type ExistingCompanySummaryRow = {
  company_number: string;
  directors_detail: string | null;
};

function createConcurrencyLimiter(limit: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (active >= limit) return;
    const fn = queue.shift();
    if (!fn) return;
    active += 1;
    fn();
  };
  return async <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
}

function parseDirectorsDetail(raw: string | undefined): DirectorDetail[] {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as DirectorDetail[]) : [];
  } catch {
    return [];
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

async function readLastProcessedAtMs(): Promise<number> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("ingest_state")
    .select("value")
    .eq("key", STATE_KEY)
    .maybeSingle<{ value: string }>();

  if (error) throw error;
  const parsed = parseIsoMs(data?.value);
  if (parsed !== null) return parsed;

  const nowMs = Date.now();
  const bootstrapMs =
    Number.isFinite(BOOTSTRAP_MINUTES) && BOOTSTRAP_MINUTES > 0
      ? BOOTSTRAP_MINUTES * 60 * 1000
      : 5 * 60 * 1000;
  const fallback = Math.max(0, nowMs - bootstrapMs);
  const fallbackIso = new Date(fallback).toISOString();
  const { error: upsertError } = await supabase
    .from("ingest_state")
    .upsert({ key: STATE_KEY, value: fallbackIso, updated_at: fallbackIso }, { onConflict: "key" });
  if (upsertError) throw upsertError;
  console.log(
    `[Ingest] No prior state found; bootstrapping from last ${Math.round(
      bootstrapMs / 60000
    )} minute(s): ${fallbackIso}`
  );
  return fallback;
}

async function writeLastProcessedAt(nowIso: string): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("ingest_state")
    .upsert({ key: STATE_KEY, value: nowIso, updated_at: nowIso }, { onConflict: "key" });
  if (error) throw error;
}

async function readKnownCompanyNumbers(): Promise<Set<string>> {
  const supabase = getSupabaseAdminClient();
  const known = new Set<string>();
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("companies")
      .select("company_number")
      .range(from, to);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows as Array<{ company_number: string | null }>) {
      const companyNumber = String(row.company_number || "").trim();
      if (!companyNumber) continue;
      known.add(companyNumber);
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return known;
}

async function readOfficerSummaries(
  officerIds: string[]
): Promise<Map<string, OfficerSummary>> {
  const supabase = getSupabaseAdminClient();
  const out = new Map<string, OfficerSummary>();
  for (const group of chunk(officerIds, 200)) {
    const { data, error } = await supabase
      .from("officer_appointment_summary")
      .select("officer_id, has_previous_appointments, previous_distinct_companies, updated_at")
      .in("officer_id", group);
    if (error) throw error;
    for (const row of (data || []) as OfficerSummary[]) {
      out.set(row.officer_id, row);
    }
  }
  return out;
}

async function readCachedOfficerAppointmentKeys(
  officerIds: string[]
): Promise<Set<string>> {
  const supabase = getSupabaseAdminClient();
  const existingKeys = new Set<string>();
  const keys = officerIds.map((officerId) => `officer_appointments:${officerId}`);
  for (const group of chunk(keys, 200)) {
    const { data, error } = await supabase
      .from("ingest_state")
      .select("key")
      .in("key", group);
    if (error) throw error;
    for (const row of (data || []) as Array<{ key: string }>) {
      existingKeys.add(row.key);
    }
  }
  return existingKeys;
}

function extractOfficerIds(rows: RowWithDirectorsDetail[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const d of parseDirectorsDetail(row.directors_detail || undefined)) {
      const id = String(d.officer_id || "").trim();
      if (!id) continue;
      ids.add(id);
    }
  }
  return Array.from(ids);
}

function distinctCompanyCount(appointments: OfficerAppointmentItem[]): number {
  const companies = new Set<string>();
  for (const a of appointments) {
    const companyNumber = String(
      a.appointed_to?.company_number || a.company_number || ""
    ).trim();
    if (!companyNumber) continue;
    companies.add(companyNumber);
  }
  return companies.size;
}

async function refreshOfficerSummaries(
  officerIds: string[],
  existing: Map<string, OfficerSummary>,
  nowMs: number
): Promise<Map<string, OfficerSummary>> {
  const ttlMs =
    (Number.isFinite(OFFICER_CACHE_TTL_HOURS) && OFFICER_CACHE_TTL_HOURS > 0
      ? OFFICER_CACHE_TTL_HOURS
      : 24) *
    60 *
    60 *
    1000;
  const cachedAppointmentKeys = await readCachedOfficerAppointmentKeys(officerIds);
  const staleOrMissing = officerIds.filter((officerId) => {
    const row = existing.get(officerId);
    const cacheKey = `officer_appointments:${officerId}`;
    const isCacheMissing = !cachedAppointmentKeys.has(cacheKey);
    if (!row) return true;
    const updatedAtMs = Date.parse(row.updated_at || "");
    if (Number.isNaN(updatedAtMs)) return true;
    if (isCacheMissing) return true;
    return nowMs - updatedAtMs > ttlMs;
  });

  const capped =
    Number.isFinite(OFFICER_ENRICH_MAX_PER_RUN) && OFFICER_ENRICH_MAX_PER_RUN > 0
      ? staleOrMissing.slice(0, OFFICER_ENRICH_MAX_PER_RUN)
      : staleOrMissing;
  if (capped.length === 0) return existing;

  const chClient = new CompaniesHouseClient(process.env.COMPANIES_HOUSE_API_KEY || "");
  const limiter = createConcurrencyLimiter(
    Number.isFinite(OFFICER_ENRICH_CONCURRENCY) && OFFICER_ENRICH_CONCURRENCY > 0
      ? OFFICER_ENRICH_CONCURRENCY
      : 3
  );
  const fetched: OfficerSummary[] = [];
  const appointmentCacheRows: AppointmentCacheRow[] = [];

  await Promise.all(
    capped.map((officerId) =>
      limiter(async () => {
        try {
          const appointments = await chClient.getOfficerAppointments(officerId);
          const distinctCompanies = distinctCompanyCount(appointments);
          const updatedAt = new Date(nowMs).toISOString();
          fetched.push({
            officer_id: officerId,
            has_previous_appointments: distinctCompanies > 1,
            previous_distinct_companies: distinctCompanies,
            updated_at: updatedAt,
          });
          appointmentCacheRows.push({
            key: `officer_appointments:${officerId}`,
            value: JSON.stringify(appointments),
            updated_at: updatedAt,
          });
        } catch (error) {
          console.error(`[Ingest] Failed officer summary for ${officerId}:`, error);
        }
      })
    )
  );

  if (fetched.length > 0) {
    const supabase = getSupabaseAdminClient();
    const { error: summaryError } = await supabase
      .from("officer_appointment_summary")
      .upsert(fetched, { onConflict: "officer_id" });
    if (summaryError) throw summaryError;
    if (appointmentCacheRows.length > 0) {
      const { error: cacheError } = await supabase
        .from("ingest_state")
        .upsert(appointmentCacheRows, { onConflict: "key" });
      if (cacheError) throw cacheError;
    }
    for (const row of fetched) existing.set(row.officer_id, row);
  }

  return existing;
}

function attachPreviousAppointmentsSummary(
  rows: PipelineRow[],
  officerSummaries: Map<string, OfficerSummary>
): PipelineRow[] {
  return rows.map((row) => {
    const directors = parseDirectorsDetail(row.directors_detail);
    if (directors.length === 0) {
      return {
        ...row,
        has_previous_appointments: null,
        previous_appointments_count: null,
      };
    }

    let known = 0;
    let previousCount = 0;
    for (const d of directors) {
      const summary = officerSummaries.get(d.officer_id);
      if (!summary) continue;
      known += 1;
      if (summary.has_previous_appointments) previousCount += 1;
    }
    if (known === 0) {
      return {
        ...row,
        has_previous_appointments: null,
        previous_appointments_count: null,
      };
    }
    return {
      ...row,
      has_previous_appointments: previousCount > 0,
      previous_appointments_count: previousCount,
    };
  });
}

async function readCompaniesForSummaryRefresh(): Promise<ExistingCompanySummaryRow[]> {
  const supabase = getSupabaseAdminClient();
  const limit =
    Number.isFinite(SUMMARY_BACKFILL_COMPANY_LIMIT) &&
    SUMMARY_BACKFILL_COMPANY_LIMIT > 0
      ? SUMMARY_BACKFILL_COMPANY_LIMIT
      : 500;
  const { data, error } = await supabase
    .from("companies")
    .select("company_number, directors_detail")
    .order("last_seen_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []) as ExistingCompanySummaryRow[];
}

async function updateExistingCompanySummaries(
  rows: ExistingCompanySummaryRow[],
  officerSummaries: Map<string, OfficerSummary>
): Promise<number> {
  if (rows.length === 0) return 0;
  const supabase = getSupabaseAdminClient();
  let updated = 0;
  for (const row of rows) {
    const directors = parseDirectorsDetail(row.directors_detail || undefined);
    if (directors.length === 0) {
      const { error } = await supabase
        .from("companies")
        .update({
          has_previous_appointments: null,
          previous_appointments_count: null,
        })
        .eq("company_number", row.company_number);
      if (error) throw error;
      updated += 1;
      continue;
    }

    let known = 0;
    let previousCount = 0;
    for (const d of directors) {
      const summary = officerSummaries.get(d.officer_id);
      if (!summary) continue;
      known += 1;
      if (summary.has_previous_appointments) previousCount += 1;
    }

    const payload =
      known === 0
        ? {
            has_previous_appointments: null,
            previous_appointments_count: null,
          }
        : {
            has_previous_appointments: previousCount > 0,
            previous_appointments_count: previousCount,
          };

    const { error } = await supabase
      .from("companies")
      .update(payload)
      .eq("company_number", row.company_number);
    if (error) throw error;
    updated += 1;
  }
  return updated;
}

async function upsertCompanies(nowIso: string, rows: Awaited<ReturnType<typeof runPipeline>>["rows"]) {
  if (rows.length === 0) return;
  const supabase = getSupabaseAdminClient();
  const payload = rows.map((row) => ({
    company_number: row.company_number,
    company_name: row.company_name,
    incorporation_date: row.incorporation_date || null,
    last_seen_at: nowIso,
    sic_codes: row.sic_codes || null,
    company_type: row.company_type || null,
    registered_office_address: row.registered_office_address || null,
    directors: row.directors || null,
    directors_detail: row.directors_detail || null,
    has_previous_appointments:
      typeof row.has_previous_appointments === "boolean"
        ? row.has_previous_appointments
        : null,
    previous_appointments_count:
      typeof row.previous_appointments_count === "number"
        ? row.previous_appointments_count
        : null,
    has_linkedin: row.has_linkedin,
    linkedin_url: row.linkedin_url,
  }));

  const { error } = await supabase
    .from("companies")
    .upsert(payload, { onConflict: "company_number" });
  if (error) throw error;
}

async function pruneExpiredRows(nowMs: number): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const cutoffIso = new Date(nowMs - RETENTION_MS).toISOString();
  const { error } = await supabase
    .from("companies")
    .delete()
    .lt("last_seen_at", cutoffIso);
  if (error) throw error;
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const lastProcessedAtMs = await readLastProcessedAtMs();
  const knownCompanyNumbers = await readKnownCompanyNumbers();
  const initialBackfillMs =
    Number.isFinite(INITIAL_BACKFILL_HOURS) && INITIAL_BACKFILL_HOURS > 0
      ? INITIAL_BACKFILL_HOURS * 60 * 60 * 1000
      : 5 * 60 * 60 * 1000;
  const initialSinceMs = Math.max(0, nowMs - initialBackfillMs);
  const incrementalSinceMs = Math.max(0, lastProcessedAtMs - INGEST_OVERLAP_MS);
  const sinceMs =
    knownCompanyNumbers.size === 0
      ? Math.max(initialSinceMs, incrementalSinceMs)
      : incrementalSinceMs;
  const sinceIso = new Date(sinceMs).toISOString();

  console.log(
    `[Ingest] Start window: ${sinceIso} -> ${nowIso} (known companies: ${knownCompanyNumbers.size})`
  );
  const result = await runPipeline({
    since: new Date(sinceMs),
    now: new Date(nowMs),
    excludeCompanyNumbers: knownCompanyNumbers,
  });
  console.log(`[Ingest] Pipeline returned ${result.rows.length} rows`);

  if (result.rows.length > 0) {
    const officerIds = extractOfficerIds(result.rows);
    console.log(`[Ingest] Officer summary candidates: ${officerIds.length}`);
    const existingOfficerSummaries = await readOfficerSummaries(officerIds);
    const updatedOfficerSummaries = await refreshOfficerSummaries(
      officerIds,
      existingOfficerSummaries,
      nowMs
    );
    const enrichedRows = attachPreviousAppointmentsSummary(
      result.rows,
      updatedOfficerSummaries
    );
    await upsertCompanies(nowIso, enrichedRows);
  } else {
    const companiesForSummaryRefresh = await readCompaniesForSummaryRefresh();
    const officerIds = extractOfficerIds(companiesForSummaryRefresh);
    console.log(
      `[Ingest] No new rows; summary refresh for recent companies: ${companiesForSummaryRefresh.length}, officers: ${officerIds.length}`
    );
    const existingOfficerSummaries = await readOfficerSummaries(officerIds);
    const updatedOfficerSummaries = await refreshOfficerSummaries(
      officerIds,
      existingOfficerSummaries,
      nowMs
    );
    const updatedCompanies = await updateExistingCompanySummaries(
      companiesForSummaryRefresh,
      updatedOfficerSummaries
    );
    console.log(
      `[Ingest] Backfilled previous-appointment fields for ${updatedCompanies} companies`
    );
  }

  await pruneExpiredRows(nowMs);
  await writeLastProcessedAt(nowIso);

  console.log("[Ingest] Completed successfully");
}

main().catch((error) => {
  console.error("[Ingest] Failed:", error);
  process.exitCode = 1;
});
