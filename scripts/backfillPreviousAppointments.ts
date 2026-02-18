import nextEnv from "@next/env";
import { CompaniesHouseClient } from "../companiesHouseClient.js";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin.js";
import type { DirectorDetail } from "../lib/runPipeline.js";
import type { OfficerAppointmentItem } from "../companiesHouseClient.js";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const OFFICER_CACHE_TTL_HOURS = Number.parseInt(
  process.env.OFFICER_CACHE_TTL_HOURS || "24",
  10
);
const OFFICER_ENRICH_CONCURRENCY = Number.parseInt(
  process.env.OFFICER_ENRICH_CONCURRENCY || "3",
  10
);
const OFFICER_ENRICH_MAX_PER_RUN = Number.parseInt(
  process.env.OFFICER_ENRICH_MAX_PER_RUN || "500",
  10
);
const BACKFILL_COMPANY_LIMIT = Number.parseInt(
  process.env.BACKFILL_COMPANY_LIMIT || "500",
  10
);
const COMPANY_UPDATE_CONCURRENCY = Number.parseInt(
  process.env.COMPANY_UPDATE_CONCURRENCY || "20",
  10
);

type CompanyRow = {
  company_number: string;
  directors_detail: string | null;
};

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

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parseDirectorsDetail(raw: string | null | undefined): DirectorDetail[] {
  if (!raw || typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as DirectorDetail[]) : [];
  } catch {
    return [];
  }
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

async function readTargetCompanies(): Promise<CompanyRow[]> {
  const supabase = getSupabaseAdminClient();
  const limit =
    Number.isFinite(BACKFILL_COMPANY_LIMIT) && BACKFILL_COMPANY_LIMIT > 0
      ? BACKFILL_COMPANY_LIMIT
      : 500;
  const { data, error } = await supabase
    .from("companies")
    .select("company_number, directors_detail")
    .order("last_seen_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []) as CompanyRow[];
}

function extractOfficerIds(companies: CompanyRow[]): string[] {
  const ids = new Set<string>();
  for (const row of companies) {
    for (const d of parseDirectorsDetail(row.directors_detail)) {
      const officerId = String(d.officer_id || "").trim();
      if (!officerId) continue;
      ids.add(officerId);
    }
  }
  return Array.from(ids);
}

async function readOfficerSummaries(officerIds: string[]): Promise<Map<string, OfficerSummary>> {
  const supabase = getSupabaseAdminClient();
  const out = new Map<string, OfficerSummary>();
  for (const group of chunk(officerIds, 200)) {
    const { data, error } = await supabase
      .from("officer_appointment_summary")
      .select("officer_id, has_previous_appointments, previous_distinct_companies, updated_at")
      .in("officer_id", group);
    if (error) throw error;
    for (const row of (data || []) as OfficerSummary[]) out.set(row.officer_id, row);
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

async function refreshOfficerSummaries(
  officerIds: string[],
  existing: Map<string, OfficerSummary>
): Promise<Map<string, OfficerSummary>> {
  const ttlMs =
    (Number.isFinite(OFFICER_CACHE_TTL_HOURS) && OFFICER_CACHE_TTL_HOURS > 0
      ? OFFICER_CACHE_TTL_HOURS
      : 24) *
    60 *
    60 *
    1000;
  const nowMs = Date.now();
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

  const apiKey = process.env.COMPANIES_HOUSE_API_KEY || "";
  const client = new CompaniesHouseClient(apiKey);
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
          const appointments = await client.getOfficerAppointments(officerId);
          const distinct = distinctCompanyCount(appointments);
          const updatedAt = new Date(nowMs).toISOString();
          fetched.push({
            officer_id: officerId,
            has_previous_appointments: distinct > 1,
            previous_distinct_companies: distinct,
            updated_at: updatedAt,
          });
          appointmentCacheRows.push({
            key: `officer_appointments:${officerId}`,
            value: JSON.stringify(appointments),
            updated_at: updatedAt,
          });
        } catch (error) {
          console.error(`[Backfill] Failed officer ${officerId}:`, error);
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

async function writeCompanySummaries(
  companies: CompanyRow[],
  summaries: Map<string, OfficerSummary>
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const limiter = createConcurrencyLimiter(
    Number.isFinite(COMPANY_UPDATE_CONCURRENCY) && COMPANY_UPDATE_CONCURRENCY > 0
      ? COMPANY_UPDATE_CONCURRENCY
      : 20
  );
  let updated = 0;

  await Promise.all(
    companies.map((company) =>
      limiter(async () => {
        const directors = parseDirectorsDetail(company.directors_detail);
        if (directors.length === 0) {
          const { error } = await supabase
            .from("companies")
            .update({
              has_previous_appointments: null,
              previous_appointments_count: null,
            })
            .eq("company_number", company.company_number);
          if (error) throw error;
          updated += 1;
          return;
        }

        let known = 0;
        let previousCount = 0;
        for (const d of directors) {
          const summary = summaries.get(d.officer_id);
          if (!summary) continue;
          known += 1;
          if (summary.has_previous_appointments) previousCount += 1;
        }

        const payload =
          known === 0
            ? { has_previous_appointments: null, previous_appointments_count: null }
            : {
                has_previous_appointments: previousCount > 0,
                previous_appointments_count: previousCount,
              };

        const { error } = await supabase
          .from("companies")
          .update(payload)
          .eq("company_number", company.company_number);
        if (error) throw error;
        updated += 1;
      })
    )
  );

  console.log(`[Backfill] Updated company summaries: ${updated}`);
}

async function main(): Promise<void> {
  const companies = await readTargetCompanies();
  console.log(`[Backfill] Target companies: ${companies.length}`);
  if (companies.length === 0) {
    console.log("[Backfill] Nothing to do");
    return;
  }

  const officerIds = extractOfficerIds(companies);
  console.log(`[Backfill] Unique officers: ${officerIds.length}`);
  const existing = await readOfficerSummaries(officerIds);
  const merged = await refreshOfficerSummaries(officerIds, existing);
  await writeCompanySummaries(companies, merged);
  console.log("[Backfill] Done");
}

main().catch((error) => {
  console.error("[Backfill] Failed:", error);
  process.exitCode = 1;
});
