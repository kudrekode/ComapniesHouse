import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getSupabaseAdminClient } from "../../../lib/supabaseAdmin";
import type { PipelineResult, PipelineRow } from "../../../lib/runPipeline";
import { normalizeSectorFilter, rowMatchesSectorFilter } from "../../../lib/sicSector";

const DASHBOARD_CACHE_SECONDS = 5 * 60;
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 500;

const CACHE_HEADERS = {
  "Cache-Control": `public, max-age=0, s-maxage=${DASHBOARD_CACHE_SECONDS}, stale-while-revalidate=60`,
};

type CompanyDbRow = {
  company_name: string;
  company_number: string;
  incorporation_date: string | null;
  first_seen_at: string;
  has_previous_appointments: boolean | null;
  previous_appointments_count: number | null;
  sic_codes: string | null;
  company_type: string | null;
  registered_office_address: string | null;
  directors: string | null;
  directors_detail: string | null;
  has_linkedin: boolean | null;
  linkedin_url: string | null;
  website_url: string | null;
  contact_confidence: number | null;
  contact_source: string | null;
  search_confidence_score: number | null;
  search_confidence_reasons: string[] | null;
  search_disqualified: boolean | null;
  search_disqualify_reason: string | null;
};

type TimeWindow = "today" | "24h" | "6h" | "60m" | "30m";
type SortOrder = "freshest" | "date_asc" | "confidence_desc";
type PreviousAppointmentsFilter = "any" | "yes" | "no";

type QueryParams = {
  page: number;
  pageSize: number;
  sicFilter: string;
  sectorFilter: string[];
  timeWindow: TimeWindow;
  sortOrder: SortOrder;
  previousAppointmentsFilter: PreviousAppointmentsFilter;
};

function toPipelineRow(row: CompanyDbRow): PipelineRow {
  return {
    company_name: row.company_name,
    company_number: row.company_number,
    incorporation_date: row.incorporation_date ?? "",
    first_seen_at: row.first_seen_at,
    has_previous_appointments: row.has_previous_appointments,
    previous_appointments_count: row.previous_appointments_count,
    sic_codes: row.sic_codes ?? "",
    company_type: row.company_type ?? "",
    registered_office_address: row.registered_office_address ?? "",
    directors: row.directors ?? "",
    directors_detail: row.directors_detail ?? "[]",
    has_linkedin: Boolean(row.has_linkedin),
    linkedin_url: row.linkedin_url,
    website_url: row.website_url,
    contact_confidence: row.contact_confidence,
    contact_source: row.contact_source,
    search_confidence_score: row.search_confidence_score,
    search_confidence_reasons: row.search_confidence_reasons,
    search_disqualified: row.search_disqualified,
    search_disqualify_reason: row.search_disqualify_reason,
  };
}

function asPositiveInt(raw: string | null, fallback: number): number {
  const value = Number.parseInt(String(raw || ""), 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function normalizeTimeWindow(raw: string | null): TimeWindow {
  if (raw === "24h" || raw === "6h" || raw === "60m" || raw === "30m") return raw;
  return "today";
}

function normalizeSortOrder(raw: string | null): SortOrder {
  if (raw === "date_asc" || raw === "confidence_desc") return raw;
  return "freshest";
}

function normalizePreviousAppointmentsFilter(raw: string | null): PreviousAppointmentsFilter {
  if (raw === "yes" || raw === "no") return raw;
  return "any";
}

function parseQueryParams(request: NextRequest): QueryParams {
  const search = request.nextUrl.searchParams;
  const page = asPositiveInt(search.get("page"), 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, asPositiveInt(search.get("pageSize"), DEFAULT_PAGE_SIZE));
  return {
    page,
    pageSize,
    sicFilter: String(search.get("sicFilter") || "").trim(),
    sectorFilter: normalizeSectorFilter(String(search.get("sectorFilter") || "")),
    timeWindow: normalizeTimeWindow(search.get("timeWindow")),
    sortOrder: normalizeSortOrder(search.get("sortOrder")),
    previousAppointmentsFilter: normalizePreviousAppointmentsFilter(
      search.get("previousAppointmentsFilter")
    ),
  };
}

function buildSicCodes(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function windowRange(window: TimeWindow): { startIso: string; endIso: string } {
  const now = new Date();
  const endIso = now.toISOString();
  if (window === "today") {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return { startIso: start.toISOString(), endIso };
  }
  const windowMinutesMap: Record<Exclude<TimeWindow, "today">, number> = {
    "24h": 24 * 60,
    "6h": 6 * 60,
    "60m": 60,
    "30m": 30,
  };
  const start = new Date(now.getTime() - windowMinutesMap[window] * 60 * 1000);
  return { startIso: start.toISOString(), endIso };
}

function applyDashboardFilters(
  query: any,
  params: Pick<QueryParams, "sicFilter" | "timeWindow" | "previousAppointmentsFilter">
): any {
  let nextQuery = query;
  const sicCodes = buildSicCodes(params.sicFilter);
  if (sicCodes.length > 0) {
    const orFilter = sicCodes
      .map((code) => `sic_codes.ilike.%${code.replace(/[%_]/g, "")}%`)
      .join(",");
    nextQuery = nextQuery.or(orFilter);
  }

  if (params.previousAppointmentsFilter === "yes") {
    nextQuery = nextQuery.eq("has_previous_appointments", true);
  } else if (params.previousAppointmentsFilter === "no") {
    nextQuery = nextQuery.eq("has_previous_appointments", false);
  }

  const range = windowRange(params.timeWindow);
  nextQuery = nextQuery.gte("first_seen_at", range.startIso).lte("first_seen_at", range.endIso);
  return nextQuery;
}

function applySort(query: any, sortOrder: SortOrder): any {
  if (sortOrder === "date_asc") {
    return query.order("incorporation_date", { ascending: true, nullsFirst: false });
  }
  if (sortOrder === "confidence_desc") {
    return query
      .order("search_confidence_score", { ascending: false, nullsFirst: false })
      .order("contact_confidence", { ascending: false, nullsFirst: false })
      .order("first_seen_at", { ascending: false, nullsFirst: false });
  }
  return query.order("first_seen_at", { ascending: false, nullsFirst: false });
}

function cacheKeyFor(params: QueryParams): string {
  const sectorKey = params.sectorFilter.length > 0 ? params.sectorFilter.join(".") : "-";
  return `dashboard-run-v3:p${params.page}:s${params.pageSize}:tw${params.timeWindow}:sort${params.sortOrder}:prev${params.previousAppointmentsFilter}:sic${params.sicFilter || "-"}:sector${sectorKey}`;
}

async function loadDashboardData(params: QueryParams): Promise<PipelineResult> {
  const supabase = getSupabaseAdminClient();
  const from = (params.page - 1) * params.pageSize;
  const to = from + params.pageSize - 1;
  const columns =
    "company_name, company_number, incorporation_date, first_seen_at, has_previous_appointments, previous_appointments_count, sic_codes, company_type, registered_office_address, directors, directors_detail, has_linkedin, linkedin_url, website_url, contact_confidence, contact_source, search_confidence_score, search_confidence_reasons, search_disqualified, search_disqualify_reason";

  const rowsQueryBase = supabase.from("companies").select(columns, { count: "exact" });
  const rowsQueryFiltered = applySort(applyDashboardFilters(rowsQueryBase, params), params.sortOrder).range(
    from,
    to
  );
  const rowsQueryForSector = applySort(applyDashboardFilters(rowsQueryBase, params), params.sortOrder);

  const todayRange = windowRange("today");

  const [rowsResult, rowsForSectorResult, stateResult, totalRowsResult, enrichedTodayResult, linkedinMatchesResult] =
    await Promise.all([
      rowsQueryFiltered,
      params.sectorFilter.length > 0 ? rowsQueryForSector : Promise.resolve(null),
      supabase
        .from("ingest_state")
        .select("value")
        .eq("key", "last_processed_at")
        .maybeSingle<{ value: string }>(),
      supabase.from("companies").select("company_number", { count: "exact", head: true }),
      supabase
        .from("companies")
        .select("company_number", { count: "exact", head: true })
        .gte("first_seen_at", todayRange.startIso)
        .lte("first_seen_at", todayRange.endIso),
      supabase
        .from("companies")
        .select("company_number", { count: "exact", head: true })
        .gte("first_seen_at", todayRange.startIso)
        .lte("first_seen_at", todayRange.endIso)
        .or("has_linkedin.eq.true,linkedin_url.not.is.null"),
    ]);

  if (rowsResult.error) throw rowsResult.error;
  if (rowsForSectorResult && rowsForSectorResult.error) throw rowsForSectorResult.error;
  if (stateResult.error) throw stateResult.error;
  if (totalRowsResult.error) throw totalRowsResult.error;
  if (enrichedTodayResult.error) throw enrichedTodayResult.error;
  if (linkedinMatchesResult.error) throw linkedinMatchesResult.error;

  let rows = (rowsResult.data || []).map(toPipelineRow);
  let totalCount = rowsResult.count || 0;
  if (params.sectorFilter.length > 0) {
    const sectorRows: PipelineRow[] = (rowsForSectorResult?.data || []).map(toPipelineRow);
    const sectorFilteredRows = sectorRows.filter((row: PipelineRow) =>
      rowMatchesSectorFilter(row.sic_codes, params.sectorFilter)
    );
    totalCount = sectorFilteredRows.length;
    rows = sectorFilteredRows.slice(from, to + 1);
  }
  const totalRows = totalRowsResult.count || 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / params.pageSize));
  const enrichedToday = enrichedTodayResult.count || 0;
  const linkedInMatches = linkedinMatchesResult.count || 0;
  const matchRate = enrichedToday > 0 ? (linkedInMatches / enrichedToday) * 100 : 0;

  return {
    updatedAt: stateResult.data?.value || new Date().toISOString(),
    rows,
    totalCount,
    totalRows,
    page: params.page,
    pageSize: params.pageSize,
    totalPages,
    summary: {
      enrichedToday,
      linkedInMatches,
      matchRate,
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const params = parseQueryParams(request);
    const cachedLoader = unstable_cache(
      async () => loadDashboardData(params),
      [cacheKeyFor(params)],
      { revalidate: DASHBOARD_CACHE_SECONDS }
    );
    const result = await cachedLoader();
    return NextResponse.json(result, { status: 200, headers: CACHE_HEADERS });
  } catch (error) {
    console.error("DB read failed:", error);
    return NextResponse.json({ error: "Failed to load dashboard data" }, { status: 500 });
  }
}
