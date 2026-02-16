import "dotenv/config";
import { CompaniesHouseClient } from "./companiesHouseClient.js";
import type { CompanyProfile } from "./companiesHouseClient.js";
import { EnrichmentService } from "./enrichmentService.js";
import { exportToCsv } from "./csvExporter.js";
import type { CsvRow } from "./csvExporter.js";


const API_KEY = process.env.COMPANIES_HOUSE_API_KEY || "";
const OUTPUT_CSV = process.env.OUTPUT_CSV || "companies.csv";
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || "4", 10);
const MAX_COMPANIES = Number.parseInt(process.env.MAX_COMPANIES || "0", 10);
const ENABLE_LINKEDIN_LOOKUP =
  (process.env.ENABLE_LINKEDIN_LOOKUP || "false").toLowerCase() === "true";

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function matchesFilters(profile: CompanyProfile): boolean {
  const status = (profile.company_status || "").toLowerCase();
  const companyType = (profile.type || "").toLowerCase();
  return status === "active" && companyType === "ltd";
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

async function main(): Promise<void> {
  const client = new CompaniesHouseClient(API_KEY);
  const enrichment = ENABLE_LINKEDIN_LOOKUP ? new EnrichmentService() : null;
  const safeConcurrency =
    Number.isFinite(CONCURRENCY) && CONCURRENCY > 0 ? CONCURRENCY : 4;

  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const fromDate = toDateOnly(since);
  const toDate = toDateOnly(now);

  const companies = await client.searchCompaniesIncorporatedBetween(
    fromDate,
    toDate
  );

  const selectedCompanies: CompanyProfile[] = [];
  let profileFetchedCount = 0;

  for (const company of companies) {
    try {
      const profile = await client.getCompanyProfile(company.company_number);
      profileFetchedCount += 1;

      if (!matchesFilters(profile)) {
        continue;
      }

      selectedCompanies.push(profile);
      if (Number.isFinite(MAX_COMPANIES) && MAX_COMPANIES > 0 && selectedCompanies.length >= MAX_COMPANIES) {
        break;
      }
    } catch (error) {
      console.error(`Failed to fetch profile for ${company.company_number}:`, error);
    }
  }

  console.log(
    `Fetched ${companies.length} companies, checked ${profileFetchedCount} profiles, selected ${selectedCompanies.length}`
  );
  if (!ENABLE_LINKEDIN_LOOKUP) {
    console.log("LinkedIn lookup disabled (set ENABLE_LINKEDIN_LOOKUP=true to enable).");
  }

  const limiter = createConcurrencyLimiter(safeConcurrency);

  const rows: CsvRow[] = await Promise.all(
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

  await exportToCsv(rows, OUTPUT_CSV);
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

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exitCode = 1;
});

