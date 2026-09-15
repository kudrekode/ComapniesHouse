export type DirectorDetail = { name: string; officer_id: string };

export type PipelineRow = {
  company_name: string;
  company_number: string;
  incorporation_date: string;
  /** Timestamp of when the company was first seen in this dashboard store. */
  first_seen_at?: string;
  /** True if any current director has prior appointments on other companies. */
  has_previous_appointments?: boolean | null;
  /** Number of current directors with prior appointments on other companies. */
  previous_appointments_count?: number | null;
  sic_codes: string;
  company_type: string;
  registered_office_address: string;
  directors: string;
  /** JSON array of { name, officer_id } for fetching previous appointments (optional for backwards compatibility) */
  directors_detail?: string;
  has_linkedin: boolean;
  linkedin_url: string | null;
  website_url?: string | null;
  contact_confidence?: number | null;
  contact_source?: string | null;
  search_confidence_score?: number | null;
  search_confidence_reasons?: string[] | null;
  search_disqualified?: boolean | null;
  search_disqualify_reason?: string | null;
};

export type PipelineResult = {
  updatedAt: string;
  rows: PipelineRow[];
  totalCount?: number;
  totalRows?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  summary?: {
    enrichedToday: number;
    linkedInMatches: number;
    matchRate: number;
    /** Present in the local demo summary to distinguish scored rows from the sample size. */
    enrichmentAttempts?: number;
  };
};

export type RunPipelineOptions = {
  /**
   * Optional lower bound for incremental ingestion.
   * If omitted, pipeline falls back to default lookback window.
   */
  since?: Date;
  /** Optional upper bound (defaults to current time). */
  now?: Date;
  /** Optional list/set of company numbers to skip (already ingested). */
  excludeCompanyNumbers?: Iterable<string>;
};

import { CompaniesHouseClient } from "../companiesHouseClient.js";
import type { CompanyProfile, OfficerItem } from "../companiesHouseClient.js";
import { EnrichmentService } from "../enrichmentService.js";

/** Extract officer_id from links.officer.appointments URL (e.g. .../officers/Abc123/appointments). */
function officerIdFromAppointmentsLink(link: string | undefined): string | null {
  if (!link || typeof link !== "string") return null;
  const match = link.match(/\/officers\/([^/]+)\/appointments\/?$/);
  const id = match?.[1];
  return id ?? null;
}

function readRuntimeConfig() {
  const apiKey = process.env.COMPANIES_HOUSE_API_KEY || "";
  const concurrency = Number.parseInt(process.env.CONCURRENCY || "4", 10);
  const maxCompanies = Number.parseInt(process.env.MAX_COMPANIES || "0", 10);
  /**
   * Cap how many companies we fetch profiles for per run. 0 = no limit (all companies).
   * With 5-min refresh, use 0 for all, or a finite number as a safety cap.
   */
  const maxCompaniesToCheck = Number.parseInt(
    process.env.MAX_COMPANIES_TO_CHECK || "250",
    10
  );
  const enableLinkedinLookup =
    (process.env.ENABLE_LINKEDIN_LOOKUP || "false").toLowerCase() === "true";

  return {
    apiKey,
    concurrency,
    maxCompanies,
    maxCompaniesToCheck,
    enableLinkedinLookup,
  };
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const DEFAULT_LOOKBACK_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True if the company's date_of_creation falls within the configured lookback window.
 * - If the API returns ISO datetime (e.g. 2025-02-16T14:22:00), we filter exactly.
 * - If the API returns date-only (YYYY-MM-DD), we keep only records on/after the start date.
 */
function incorporatedInLookbackWindow(
  dateOfCreation: string | undefined,
  now: Date,
  since: Date
): boolean {
  if (!dateOfCreation || typeof dateOfCreation !== "string") return false;
  const s = dateOfCreation.trim().slice(0, 10);
  if (!s) return false;
  const cutoff = since.getTime();
  const sinceDateOnly = toDateOnly(since);
  const nowDateOnly = toDateOnly(now);
  if (s.length === 10 && s[4] === "-" && s[7] === "-") {
    const withTime = dateOfCreation.trim();
    if (withTime.length > 10 && withTime[10] === "T") {
      const t = Date.parse(withTime);
      return !Number.isNaN(t) && t >= cutoff && t <= now.getTime();
    }
    return s >= sinceDateOnly && s <= nowDateOnly;
  }
  return false;
}

function matchesFilters(profile: CompanyProfile): boolean {
  const status = (profile.company_status || "").toLowerCase();
  const companyType = (profile.type || "").toLowerCase();
  return status === "active" && companyType === "ltd";
}

function uniqueNonEmpty(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const trimmed = (v || "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function formatRegisteredOfficeAddress(profile: CompanyProfile): string {
  const a = profile.registered_office_address;
  if (!a) return "";

  return uniqueNonEmpty([
    a.premises,
    a.address_line_1,
    a.address_line_2,
    a.locality,
    a.region,
    a.postal_code,
    a.country,
  ]).join(", ");
}

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

  return async <T>(task: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
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
  };
}

const PROFILE_PROGRESS_LOG_EVERY = 50;
const OFFICERS_PROGRESS_LOG_EVERY = 25;

export async function runPipeline(options: RunPipelineOptions = {}): Promise<PipelineResult> {
  const pipelineStart = Date.now();
  console.log("[Pipeline] Starting...");
  const config = readRuntimeConfig();
  const client = new CompaniesHouseClient(config.apiKey);
  const enrichment = config.enableLinkedinLookup ? new EnrichmentService() : null;
  const safeConcurrency =
    Number.isFinite(config.concurrency) && config.concurrency > 0
      ? config.concurrency
      : 4;

  const now = options.now ?? new Date();
  const requestedSince =
    options.since ?? new Date(now.getTime() - DEFAULT_LOOKBACK_WINDOW_MS);
  const since =
    requestedSince.getTime() <= now.getTime() ? requestedSince : new Date(now);
  const fromDate = toDateOnly(since);
  const toDate = toDateOnly(now);

  const cap = config.maxCompaniesToCheck;
  const excludedCompanies = new Set<string>();
  if (options.excludeCompanyNumbers) {
    for (const companyNumber of options.excludeCompanyNumbers) {
      const trimmed = String(companyNumber || "").trim();
      if (!trimmed) continue;
      excludedCompanies.add(trimmed);
    }
  }
  console.log(
    `[Pipeline] Searching companies incorporated in ingestion window (${fromDate}–${toDate})...`
  );
  const allCompanies = await client.searchCompaniesIncorporatedBetween(
    fromDate,
    toDate,
    100,
    cap
  );
  const inWindow = allCompanies.filter((c) =>
    incorporatedInLookbackWindow(c.date_of_creation, now, since)
  );
  const toCheck = inWindow.filter(
    (c) => !excludedCompanies.has((c.company_number || "").trim())
  );
  const searchElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  console.log(
    `[Pipeline] Search done in ${searchElapsed}s: ${allCompanies.length} fetched (cap ${cap}), ${inWindow.length} in ingestion window, ${toCheck.length} after excluding known companies (will fetch profiles for these).`
  );

  const selectedCompanies: CompanyProfile[] = [];
  let checked = 0;
  const profileLimiter = createConcurrencyLimiter(safeConcurrency);
  const profiles = await Promise.all(
    toCheck.map((company) =>
      profileLimiter(async () => {
        try {
          const profile = await client.getCompanyProfile(company.company_number);
          checked += 1;
          if (checked % PROFILE_PROGRESS_LOG_EVERY === 0) {
            console.log(
              `[Pipeline] Profiles: checked ${checked}/${toCheck.length}, selected ${selectedCompanies.length} so far`
            );
          }
          return profile;
        } catch (error) {
          console.error(
            `[Pipeline] Failed to fetch profile for ${company.company_number}:`,
            error
          );
          return null;
        }
      })
    )
  );
  for (const profile of profiles) {
    if (!profile) continue;
    if (!matchesFilters(profile)) continue;
    selectedCompanies.push(profile);
  }
  if (Number.isFinite(config.maxCompanies) && config.maxCompanies > 0) {
    selectedCompanies.splice(config.maxCompanies);
  }

  const profileElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  console.log(
    `[Pipeline] Profile phase done in ${profileElapsed}s: ${selectedCompanies.length} companies (active ltd). Fetching officers (concurrency ${safeConcurrency})...`
  );

  const limiter = createConcurrencyLimiter(safeConcurrency);
  let officersDone = 0;
  const totalOfficers = selectedCompanies.length;
  const rows: PipelineRow[] = await Promise.all(
    selectedCompanies.map((company) =>
      limiter(async () => {
        let officers: OfficerItem[] = [];
        try {
          officers = await client.getCompanyOfficers(company.company_number);
        } catch (error) {
          console.error(
            `[Pipeline] Failed to fetch officers for ${company.company_number}:`,
            error
          );
        }
        officersDone += 1;
        if (officersDone % OFFICERS_PROGRESS_LOG_EVERY === 0) {
          console.log(`[Pipeline] Officers: ${officersDone}/${totalOfficers} done`);
        }
        const directors = officers.filter(
          (o) => (o.officer_role || "").toLowerCase() === "director"
        );
        const directorNames = uniqueNonEmpty(directors.map((o) => o.name));
        const directorsDetail: DirectorDetail[] = directors
          .map((o: OfficerItem) => {
            const name = (o.name || "").trim();
            const officerId = officerIdFromAppointmentsLink(
              o.links?.officer?.appointments
            );
            if (!name || !officerId) return null;
            return { name, officer_id: officerId };
          })
          .filter((d): d is DirectorDetail => d !== null);

        let hasLinkedin = false;
        let linkedinUrl: string | null = null;
        if (enrichment) {
          try {
            const enriched = await enrichment.enrichCompany(company.company_name);
            hasLinkedin = enriched.has_linkedin;
            linkedinUrl = enriched.linkedin_url;
          } catch (error) {
            console.error(`LinkedIn lookup failed for ${company.company_number}:`, error);
          }
        }

        return {
          company_name: company.company_name,
          company_number: company.company_number,
          incorporation_date: company.date_of_creation || "",
          sic_codes: (company.sic_codes || []).join(";"),
          company_type: company.type || "",
          registered_office_address: formatRegisteredOfficeAddress(company),
          directors: directorNames.join(", "),
          directors_detail: JSON.stringify(directorsDetail),
          has_linkedin: hasLinkedin,
          linkedin_url: linkedinUrl,
        };
      })
    )
  );

  const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  console.log(
    `[Pipeline] Done in ${totalElapsed}s: ${rows.length} rows. Next run in 5 min will process only new companies.`
  );
  return {
    updatedAt: now.toISOString(),
    rows,
  };
}
