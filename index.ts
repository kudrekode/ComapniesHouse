import "dotenv/config";
import { CompaniesHouseClient } from "./companiesHouseClient.js";
import type { CompanySearchItem } from "./companiesHouseClient.js";
import { EnrichmentService } from "./enrichmentService.js";
import { exportToCsv } from "./csvExporter.js";
import type { CsvRow } from "./csvExporter.js";


const API_KEY = process.env.COMPANIES_HOUSE_API_KEY || "";
const OUTPUT_CSV = process.env.OUTPUT_CSV || "companies.csv";
const CONCURRENCY = Number.parseInt(process.env.CONCURRENCY || "4", 10);
const MAX_COMPANIES = Number.parseInt(process.env.MAX_COMPANIES || "0", 10);

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isActiveCompany(company: CompanySearchItem): boolean {
  const status = (company.company_status || "").toLowerCase();
  return status === "active";
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
  const enrichment = new EnrichmentService();

  const now = new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const fromDate = toDateOnly(since);
  const toDate = toDateOnly(now);

  const companies = await client.searchCompaniesIncorporatedBetween(
    fromDate,
    toDate
  );

  const activeCompanies = companies.filter(isActiveCompany);
  const selectedCompanies =
    Number.isFinite(MAX_COMPANIES) && MAX_COMPANIES > 0
      ? activeCompanies.slice(0, MAX_COMPANIES)
      : activeCompanies;

  console.log(
    `Fetched ${companies.length} companies, ${activeCompanies.length} active, processing ${selectedCompanies.length}`
  );

  const limiter = createConcurrencyLimiter(CONCURRENCY);

  const rows: CsvRow[] = await Promise.all(
    selectedCompanies.map((company) =>
      limiter(async () => {
        const officers = await client.getCompanyOfficers(company.company_number);
        const directorNames = uniqueNonEmpty(officers.map((o) => o.name));
        const enriched = await enrichment.enrichCompany(company.company_name);

        return {
          company_name: company.company_name,
          company_number: company.company_number,
          incorporation_date: company.date_of_creation || "",
          directors: directorNames.join(", "),
          has_online_presence: enriched.has_online_presence,
          website_url: enriched.website_url,
          linkedin_url: enriched.linkedin_url,
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

