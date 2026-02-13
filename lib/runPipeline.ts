export type PipelineRow = {
  company_name: string;
  company_number: string;
  incorporation_date: string;
  sic_codes: string;
  company_type: string;
  registered_office_address: string;
  directors: string;
  has_linkedin: boolean;
  linkedin_url: string | null;
};

export type PipelineResult = {
  updatedAt: string;
  rows: PipelineRow[];
};

import { CompaniesHouseClient } from "../companiesHouseClient";
import type { CompanyProfile } from "../companiesHouseClient";
import { EnrichmentService } from "../enrichmentService";

const API_KEY = process.env.COMPANIES_HOUSE_API_KEY || "";
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || "4", 10);
const MAX_COMPANIES = Number.parseInt(process.env.MAX_COMPANIES || "0", 10);
const ENABLE_LINKEDIN_LOOKUP =
  (process.env.ENABLE_LINKEDIN_LOOKUP || "false").toLowerCase() === "true";
const ALLOWED_SIC_CODES = new Set([
  "62020",
  "70229",
  "73110",
  "47910",
  "70210",
  "62010",
  "62012",
  "62090",
  "73120",
  "47990",
  "74100",
]);

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function normalizeSic(value: string): string {
  return value.trim();
}

function hasAllowedSic(sicCodes: string[] | undefined): boolean {
  if (!Array.isArray(sicCodes) || sicCodes.length === 0) {
    return false;
  }

  const normalized = sicCodes.map(normalizeSic).filter(Boolean);
  if (normalized.includes("99999")) {
    return false;
  }

  return normalized.some((code) => ALLOWED_SIC_CODES.has(code));
}

function matchesFilters(profile: CompanyProfile): boolean {
  const status = (profile.company_status || "").toLowerCase();
  const companyType = (profile.type || "").toLowerCase();

  return status === "active" && companyType === "ltd" && hasAllowedSic(profile.sic_codes);
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

export async function runPipeline(): Promise<PipelineResult> {
  const client = new CompaniesHouseClient(API_KEY);
  const enrichment = ENABLE_LINKEDIN_LOOKUP ? new EnrichmentService() : null;
  const safeConcurrency =
    Number.isFinite(CONCURRENCY) && CONCURRENCY > 0 ? CONCURRENCY : 4;

  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fromDate = toDateOnly(since);
  const toDate = toDateOnly(now);

  const companies = await client.searchCompaniesIncorporatedBetween(fromDate, toDate);

  const selectedCompanies: CompanyProfile[] = [];
  for (const company of companies) {
    try {
      const profile = await client.getCompanyProfile(company.company_number);

      if (!matchesFilters(profile)) {
        continue;
      }

      selectedCompanies.push(profile);
      if (
        Number.isFinite(MAX_COMPANIES) &&
        MAX_COMPANIES > 0 &&
        selectedCompanies.length >= MAX_COMPANIES
      ) {
        break;
      }
    } catch (error) {
      console.error(`Failed to fetch profile for ${company.company_number}:`, error);
    }
  }

  const limiter = createConcurrencyLimiter(safeConcurrency);
  const rows: PipelineRow[] = await Promise.all(
    selectedCompanies.map((company) =>
      limiter(async () => {
        const officers = await client.getCompanyOfficers(company.company_number);
        const directorNames = uniqueNonEmpty(
          officers
            .filter((o) => (o.officer_role || "").toLowerCase() === "director")
            .map((o) => o.name)
        );

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
          has_linkedin: hasLinkedin,
          linkedin_url: linkedinUrl,
        };
      })
    )
  );

  return {
    updatedAt: now.toISOString(),
    rows,
  };
}
