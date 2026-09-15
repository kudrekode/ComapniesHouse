import type { PipelineResult, PipelineRow } from "./runPipeline";
import { rowMatchesSectorFilter } from "./sicSector";

export type DemoTimeWindow = "today" | "24h" | "6h" | "60m" | "30m";
export type DemoSortOrder = "freshest" | "date_asc" | "confidence_desc";
export type DemoPreviousAppointmentsFilter = "any" | "yes" | "no";

export type DemoDashboardFilters = {
  page: number;
  pageSize: number;
  sicFilter: string;
  sectorFilter: string[];
  timeWindow: DemoTimeWindow;
  sortOrder: DemoSortOrder;
  previousAppointmentsFilter: DemoPreviousAppointmentsFilter;
};

const COMPANY_NAME_PREFIXES = [
  "Amberfield",
  "Northstar",
  "Cedarstone",
  "Brightwell",
  "Westbridge",
  "Oak & River",
  "Silver Birch",
  "Blue Lantern",
  "Red Kite",
  "Harbourlight",
  "Green Orchard",
  "Crown & Vale",
  "Marlow",
  "Pinecrest",
  "Daybreak",
];

const COMPANY_NAME_SUFFIXES = ["Analytics", "Digital", "Advisory", "Trading", "Services"];

const DIRECTOR_NAMES = [
  "Aisha Rahman",
  "Daniel Mercer",
  "Priya Shah",
  "Oliver Bennett",
  "Maya Thompson",
  "Theo Williams",
  "Grace Patel",
  "Elliot Morgan",
  "Amira Khan",
  "Jacob Hughes",
  "Sofia Lewis",
  "Noah Clarke",
  "Freya Scott",
  "Isaac Turner",
  "Leah Cooper",
];

const SIC_CODES = [
  "62020",
  "70229",
  "56101",
  "47910",
  "43210",
  "68100",
  "82990",
  "73110",
  "96090",
  "41202",
  "63110",
  "85590",
];

const LOCATIONS = [
  "London",
  "Manchester",
  "Bristol",
  "Leeds",
  "Glasgow",
  "Cardiff",
  "Birmingham",
  "Edinburgh",
  "Brighton",
  "Oxford",
];

const ENRICHMENT_SCORES = [96, 89, 83, 78, 73, 68, 64, 58, 46, 31];
const LINKEDIN_MATCH_COUNT = 5;

function matchesSicFilter(row: PipelineRow, rawFilter: string): boolean {
  const filters = rawFilter
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!filters.length) return true;
  const codes = row.sic_codes.split(";").map((value) => value.trim());
  return filters.some((filter) =>
    codes.some((code) => code.includes(filter) || filter.includes(code))
  );
}

function matchesTimeWindow(row: PipelineRow, timeWindow: DemoTimeWindow, nowMs: number): boolean {
  const firstSeenMs = Date.parse(row.first_seen_at || "");
  if (!Number.isFinite(firstSeenMs) || firstSeenMs > nowMs) return false;
  if (timeWindow === "today") {
    return new Date(firstSeenMs).toLocaleDateString() === new Date(nowMs).toLocaleDateString();
  }

  const minutes: Record<Exclude<DemoTimeWindow, "today">, number> = {
    "24h": 24 * 60,
    "6h": 6 * 60,
    "60m": 60,
    "30m": 30,
  };
  return firstSeenMs >= nowMs - minutes[timeWindow] * 60_000;
}

function confidenceFor(row: PipelineRow): number {
  return row.search_confidence_score ?? row.contact_confidence ?? -1;
}

export function createDemoRows(nowMs: number): PipelineRow[] {
  return Array.from({ length: 75 }, (_, index) => {
    const ageMinutes = 2 + ((index * 193) % 1_430);
    const firstSeenAt = new Date(nowMs - ageMinutes * 60_000).toISOString();
    const companyPrefix = COMPANY_NAME_PREFIXES[index % COMPANY_NAME_PREFIXES.length] ?? "Sample";
    const companySuffix = COMPANY_NAME_SUFFIXES[Math.floor(index / COMPANY_NAME_PREFIXES.length)] ?? "Company";
    const companyName = `${companyPrefix} ${companySuffix} Ltd`;
    const directorName = DIRECTOR_NAMES[index % DIRECTOR_NAMES.length] ?? "Demo Director";
    const sicCode = SIC_CODES[index % SIC_CODES.length] ?? "62020";
    const location = LOCATIONS[index % LOCATIONS.length] ?? "UK";
    const officerId = `demo-officer-${String(index).padStart(2, "0")}`;
    const score = ENRICHMENT_SCORES[index];
    const matched = index < LINKEDIN_MATCH_COUNT;
    const hasPreviousAppointments = index % 3 === 0;

    return {
      company_name: companyName,
      company_number: `DEMO${String(index + 1).padStart(4, "0")}`,
      incorporation_date: firstSeenAt.slice(0, 10),
      first_seen_at: firstSeenAt,
      has_previous_appointments: hasPreviousAppointments,
      previous_appointments_count: hasPreviousAppointments ? 1 : 0,
      sic_codes: sicCode,
      company_type: "ltd",
      registered_office_address: `Demo House, ${location}, UK`,
      directors: directorName,
      directors_detail: JSON.stringify([{ name: directorName, officer_id: officerId }]),
      has_linkedin: matched,
      // Intentionally omit outbound URLs: this sample is for a local, offline walkthrough.
      linkedin_url: null,
      website_url: null,
      contact_confidence: typeof score === "number" && matched ? score / 100 : null,
      contact_source: matched ? "demo-enrichment" : null,
      search_confidence_score: score ?? null,
      search_confidence_reasons:
        typeof score === "number"
          ? matched
            ? ["Director name and company context align", "Synthetic demo match"]
            : ["Possible name match", "Manual review recommended"]
          : null,
      search_disqualified: typeof score === "number" ? !matched : null,
      search_disqualify_reason:
        typeof score === "number" && !matched ? "Low confidence demo candidate" : null,
    };
  });
}

export function createDemoResult(
  allRows: PipelineRow[],
  filters: DemoDashboardFilters,
  nowMs: number
): PipelineResult {
  const filteredRows = allRows
    .filter((row) => matchesSicFilter(row, filters.sicFilter))
    .filter((row) => rowMatchesSectorFilter(row.sic_codes, filters.sectorFilter))
    .filter((row) => matchesTimeWindow(row, filters.timeWindow, nowMs))
    .filter((row) =>
      filters.previousAppointmentsFilter === "any"
        ? true
        : row.has_previous_appointments === (filters.previousAppointmentsFilter === "yes")
    );

  filteredRows.sort((left, right) => {
    if (filters.sortOrder === "date_asc") {
      return left.incorporation_date.localeCompare(right.incorporation_date);
    }
    if (filters.sortOrder === "confidence_desc") {
      const scoreDifference = confidenceFor(right) - confidenceFor(left);
      if (scoreDifference !== 0) return scoreDifference;
    }
    return Date.parse(right.first_seen_at || "") - Date.parse(left.first_seen_at || "");
  });

  const totalCount = filteredRows.length;
  const pageSize = Math.max(1, filters.pageSize);
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(Math.max(1, filters.page), totalPages);
  const enrichedCount = allRows.filter((row) => row.search_confidence_score != null).length;
  const linkedInMatches = allRows.filter((row) => row.has_linkedin).length;

  return {
    updatedAt: new Date(nowMs).toISOString(),
    rows: filteredRows.slice((page - 1) * pageSize, page * pageSize),
    totalCount,
    totalRows: allRows.length,
    page,
    pageSize,
    totalPages,
    summary: {
      enrichedToday: allRows.length,
      linkedInMatches,
      matchRate: allRows.length > 0 ? (linkedInMatches / allRows.length) * 100 : 0,
      enrichmentAttempts: enrichedCount,
    },
  };
}

export function createDemoAppointments(officerId: string): Array<{
  company_name: string;
  company_number: string;
  company_status: string;
  appointed_to: { company_name: string; company_number: string; company_status: string };
  appointed_on: string;
  resigned_on: string | null;
  officer_role: string;
}> {
  const match = officerId.match(/^demo-officer-(\d{2})$/);
  const index = match ? Number(match[1]) : -1;
  if (index < 0 || index % 3 !== 0) return [];

  const companyName = `Sample Prior Company ${String(index + 1).padStart(2, "0")} Ltd`;
  const companyNumber = `PRIOR${String(index + 1).padStart(4, "0")}`;
  return [
    {
      company_name: companyName,
      company_number: companyNumber,
      company_status: "active",
      appointed_to: {
        company_name: companyName,
        company_number: companyNumber,
        company_status: "active",
      },
      appointed_on: "2021-04-12",
      resigned_on: null,
      officer_role: "director",
    },
  ];
}
