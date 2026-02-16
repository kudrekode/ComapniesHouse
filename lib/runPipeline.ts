export type DirectorDetail = { name: string; officer_id: string };

export type PipelineRow = {
  company_name: string;
  company_number: string;
  incorporation_date: string;
  sic_codes: string;
  company_type: string;
  registered_office_address: string;
  directors: string;
  /** JSON array of { name, officer_id } for fetching previous appointments (optional for backwards compatibility) */
  directors_detail?: string;
  has_linkedin: boolean;
  linkedin_url: string | null;
};

export type PipelineResult = {
  updatedAt: string;
  rows: PipelineRow[];
};

import { CompaniesHouseClient } from "../companiesHouseClient";
import type { CompanyProfile, OfficerItem } from "../companiesHouseClient";
import { EnrichmentService } from "../enrichmentService";

/** Extract officer_id from links.officer.appointments URL (e.g. .../officers/Abc123/appointments). */
function officerIdFromAppointmentsLink(link: string | undefined): string | null {
  if (!link || typeof link !== "string") return null;
  const match = link.match(/\/officers\/([^/]+)\/appointments\/?$/);
  const id = match?.[1];
  return id ?? null;
}

const API_KEY = process.env.COMPANIES_HOUSE_API_KEY || "";
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || "4", 10);
const MAX_COMPANIES = Number.parseInt(process.env.MAX_COMPANIES || "0", 10);
/**
 * Cap how many companies we fetch profiles for per run. 0 = no limit (all companies).
 * With 5-min refresh, each run is typically ~30 new companies; use 0 to get all, or e.g. 500 as safety.
 */
const MAX_COMPANIES_TO_CHECK = Math.min(
  Number.parseInt(process.env.MAX_COMPANIES_TO_CHECK || "100", 10) || 100,
  100
);
const ENABLE_LINKEDIN_LOOKUP =
  (process.env.ENABLE_LINKEDIN_LOOKUP || "false").toLowerCase() === "true";

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const THIRTY_MINUTES_MS = 30 * 60 * 1000;

/**
 * True if the company's date_of_creation falls within the last 30 minutes.
 * - If the API returns ISO datetime (e.g. 2025-02-16T14:22:00), we filter exactly.
 * - If the API returns date-only (YYYY-MM-DD), we keep only today's companies (best effort).
 */
function incorporatedInLast30Min(dateOfCreation: string | undefined, now: Date): boolean {
  if (!dateOfCreation || typeof dateOfCreation !== "string") return false;
  const s = dateOfCreation.trim().slice(0, 10);
  if (!s) return false;
  const cutoff = now.getTime() - THIRTY_MINUTES_MS;
  const nowDateOnly = toDateOnly(now);
  if (s.length === 10 && s[4] === "-" && s[7] === "-") {
    const withTime = dateOfCreation.trim();
    if (withTime.length > 10 && withTime[10] === "T") {
      const t = Date.parse(withTime);
      return !Number.isNaN(t) && t >= cutoff && t <= now.getTime();
    }
    return s === nowDateOnly;
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

export async function runPipeline(): Promise<PipelineResult> {
  const pipelineStart = Date.now();
  console.log("[Pipeline] Starting...");
  const client = new CompaniesHouseClient(API_KEY);
  const enrichment = ENABLE_LINKEDIN_LOOKUP ? new EnrichmentService() : null;
  const safeConcurrency =
    Number.isFinite(CONCURRENCY) && CONCURRENCY > 0 ? CONCURRENCY : 4;

  const now = new Date();
  const since = new Date(now.getTime() - THIRTY_MINUTES_MS);
  const fromDate = toDateOnly(since);
  const toDate = toDateOnly(now);

  const cap = MAX_COMPANIES_TO_CHECK;
  console.log(`[Pipeline] Searching companies incorporated in last 30 min (${fromDate}–${toDate})...`);
  const allCompanies = await client.searchCompaniesIncorporatedBetween(
    fromDate,
    toDate,
    100,
    cap
  );
  const toCheck = allCompanies.filter((c) =>
    incorporatedInLast30Min(c.date_of_creation, now)
  );
  const searchElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  console.log(
    `[Pipeline] Search done in ${searchElapsed}s: ${allCompanies.length} fetched (cap ${cap}), ${toCheck.length} in last 30 min (will fetch profiles for these).`
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
  if (Number.isFinite(MAX_COMPANIES) && MAX_COMPANIES > 0) {
    selectedCompanies.splice(MAX_COMPANIES);
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
        const officers = await client.getCompanyOfficers(company.company_number);
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
  console.log(`[Pipeline] Done in ${totalElapsed}s: ${rows.length} rows. Next run in 5 min will only add new companies.`);
  return {
    updatedAt: now.toISOString(),
    rows,
  };
}
