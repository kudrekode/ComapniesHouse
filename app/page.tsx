"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import type { PipelineResult, PipelineRow, DirectorDetail } from "../lib/runPipeline";

type OfficerAppointment = {
  company_name?: string;
  company_number?: string;
  company_status?: string;
  appointed_to?: {
    company_name?: string;
    company_number?: string;
    company_status?: string;
  };
  appointed_on?: string;
  resigned_on?: string | null;
  officer_role?: string;
};

type TimeWindow = "today" | "24h" | "6h" | "60m" | "30m";
type SortOrder = "freshest" | "date_asc" | "confidence_desc";
type PreviousAppointmentsFilter = "any" | "yes" | "no";
type TutorialGraphic =
  | "overview"
  | "filters"
  | "table"
  | "exports"
  | "actions";

type TutorialStep = {
  title: string;
  description: string;
  graphic: TutorialGraphic;
};
type HelpStepDirection = "forward" | "backward";

const DEFAULT_TUTORIAL_STEP: TutorialStep = {
  title: "Help",
  description: "Use this guide to understand the dashboard controls and workflows.",
  graphic: "overview",
};

function toCsvCell(value: string | number | boolean | null | undefined): string {
  const raw = value == null ? "" : String(value);
  const escaped = raw.replace(/"/g, '""');
  return `"${escaped}"`;
}

function exportRowsToCsv(rows: PipelineRow[]): void {
  const headers = [
    "company_name",
    "company_number",
    "incorporation_date",
    "first_seen_at",
    "sic_codes",
    "company_type",
    "registered_office_address",
    "directors",
    "has_previous_appointments",
    "previous_appointments_count",
    "has_linkedin",
    "linkedin_url",
    "website_url",
    "contact_confidence",
    "contact_source",
    "search_confidence_score",
    "search_confidence_reasons",
    "search_disqualified",
    "search_disqualify_reason",
  ];
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.company_name,
        row.company_number,
        row.incorporation_date,
        row.first_seen_at ?? "",
        row.sic_codes,
        row.company_type,
        row.registered_office_address,
        row.directors,
        row.has_previous_appointments == null ? "" : row.has_previous_appointments,
        row.previous_appointments_count == null ? "" : row.previous_appointments_count,
        row.has_linkedin,
        row.linkedin_url ?? "",
        row.website_url ?? "",
        row.contact_confidence == null ? "" : row.contact_confidence,
        row.contact_source ?? "",
        row.search_confidence_score == null ? "" : row.search_confidence_score,
        (row.search_confidence_reasons || []).join("|"),
        row.search_disqualified == null ? "" : row.search_disqualified,
        row.search_disqualify_reason ?? "",
      ]
        .map((v) => toCsvCell(v))
        .join(",")
    ),
  ];

  const csv = `${lines.join("\n")}\n`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `companies-view-${timestamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportRowsToJson(rows: PipelineRow[]): void {
  const json = `${JSON.stringify(rows, null, 2)}\n`;
  const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `companies-view-${timestamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function exportRowsToXml(rows: PipelineRow[]): void {
  const xmlRows = rows
    .map((row) => {
      const fields = Object.entries(row).map(([key, rawValue]) => {
        const value =
          rawValue == null
            ? ""
            : typeof rawValue === "string"
              ? rawValue
              : JSON.stringify(rawValue);
        return `    <${key}>${xmlEscape(value)}</${key}>`;
      });
      return `  <company>\n${fields.join("\n")}\n  </company>`;
    })
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<companies>\n${xmlRows}\n</companies>\n`;
  const blob = new Blob([xml], { type: "application/xml;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `companies-view-${timestamp}.xml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseDirectorsDetail(directors_detail: string | undefined): DirectorDetail[] {
  if (!directors_detail || typeof directors_detail !== "string") return [];
  try {
    const parsed = JSON.parse(directors_detail) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowMatchesSicFilter(row: PipelineRow, sicFilter: string): boolean {
  if (!sicFilter.trim()) return true;
  const codes = sicFilter.split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean);
  if (codes.length === 0) return true;
  const rowCodes = (row.sic_codes || "").split(";").map((c) => c.trim());
  return codes.some((code) => rowCodes.some((rc) => rc.includes(code) || code.includes(rc)));
}

function buildGoogleCompanySearchUrl(row: PipelineRow): string {
  const directors = parseDirectorsDetail(row.directors_detail);
  const firstDirector = (directors[0]?.name || row.directors || "").trim();
  const parts = [
    firstDirector,
    row.company_name,
    "UK",
    "linkedin",
    "director",
  ]
    .map((p) => (p || "").trim())
    .filter(Boolean);
  const query = parts.join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function parsePrimaryIncorporationExactMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 10 && trimmed[10] === "T") {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function parseIncorporationDateOnly(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 10 && trimmed[4] === "-" && trimmed[7] === "-") return trimmed;
  if (trimmed.length > 10 && trimmed[10] === "T") return trimmed.slice(0, 10);
  return null;
}

function parseFirstSeenMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toLocalDateOnly(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function rowReferenceMs(row: PipelineRow): number | null {
  const firstSeen = parseFirstSeenMs(row.first_seen_at);
  if (firstSeen !== null) return firstSeen;
  return (
    parsePrimaryIncorporationExactMs(row.incorporation_date) ??
    null
  );
}

function rowIsWithinTimeWindow(row: PipelineRow, window: TimeWindow, nowMs: number): boolean {
  const ts = rowReferenceMs(row);
  if (ts === null) return false;

  if (window === "today") {
    const firstSeen = parseFirstSeenMs(row.first_seen_at);
    if (firstSeen !== null) {
      return toLocalDateOnly(firstSeen) === toLocalDateOnly(nowMs);
    }
    const today = toLocalDateOnly(nowMs);
    const incorporationDateOnly = parseIncorporationDateOnly(row.incorporation_date);
    if (incorporationDateOnly) return incorporationDateOnly === today;
    return ts <= nowMs;
  }

  const windowMinutesMap: Record<Exclude<TimeWindow, "today">, number> = {
    "24h": 24 * 60,
    "6h": 6 * 60,
    "60m": 60,
    "30m": 30,
  };
  const cutoff = nowMs - windowMinutesMap[window] * 60 * 1000;
  return ts >= cutoff && ts <= nowMs;
}

function rowHasKnownPreviousAppointments(
  row: PipelineRow,
  previousAppointmentsByOfficer: Record<string, number>
): boolean | null {
  if (typeof row.has_previous_appointments === "boolean") {
    return row.has_previous_appointments;
  }
  const directors = parseDirectorsDetail(row.directors_detail);
  if (directors.length === 0) return null;

  let hasKnown = false;
  for (const d of directors) {
    const count = previousAppointmentsByOfficer[d.officer_id];
    if (typeof count !== "number") continue;
    hasKnown = true;
    if (count > 0) return true;
  }
  if (!hasKnown) return null;
  return false;
}

function rowMatchesPreviousAppointmentsFilter(
  row: PipelineRow,
  filter: PreviousAppointmentsFilter,
  previousAppointmentsByOfficer: Record<string, number>
): boolean {
  if (filter === "any") return true;
  const hasPrevious = rowHasKnownPreviousAppointments(row, previousAppointmentsByOfficer);
  if (hasPrevious === null) return false;
  if (filter === "yes") return hasPrevious === true;
  return hasPrevious === false;
}

function rowConfidencePercent(row: PipelineRow): number | null {
  if (typeof row.search_confidence_score === "number") {
    return Math.max(0, Math.min(100, Math.round(row.search_confidence_score)));
  }
  if (typeof row.contact_confidence === "number") {
    const value =
      row.contact_confidence <= 1
        ? Math.round(row.contact_confidence * 100)
        : Math.round(row.contact_confidence);
    return Math.max(0, Math.min(100, value));
  }
  return null;
}

function rowIsHotLead(row: PipelineRow): boolean {
  const confidence = rowConfidencePercent(row);
  return confidence !== null && confidence >= 70;
}

function freshnessBadgeLabel(row: PipelineRow, nowMs: number): string | null {
  const ts = rowReferenceMs(row);
  if (ts === null || ts > nowMs) return null;
  const ageMinutes = Math.floor((nowMs - ts) / (60 * 1000));

  if (ageMinutes <= 30) return "NEW 30m";
  if (ageMinutes <= 60) return "NEW 60m";
  if (ageMinutes <= 180) return "NEW 3h";
  return null;
}

function incorporatedAgoLabel(row: PipelineRow, nowMs: number): string | null {
  const ts = rowReferenceMs(row);
  if (ts === null || ts > nowMs) return null;
  const ageMinutes = Math.floor((nowMs - ts) / (60 * 1000));
  if (ageMinutes < 60) {
    const mins = Math.max(1, ageMinutes);
    return `Incorporated ${mins} min${mins === 1 ? "" : "s"} ago`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) {
    return `Incorporated ${ageHours} hr${ageHours === 1 ? "" : "s"} ago`;
  }
  return null;
}

function isVeryFresh(row: PipelineRow, nowMs: number): boolean {
  const ts = rowReferenceMs(row);
  if (ts === null || ts > nowMs) return false;
  return nowMs - ts <= 30 * 60 * 1000;
}

export default function DashboardPage() {
  const [data, setData] = useState<PipelineResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sicFilter, setSicFilter] = useState("");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("today");
  const [sortOrder, setSortOrder] = useState<SortOrder>("freshest");
  const [previousAppointmentsFilter, setPreviousAppointmentsFilter] =
    useState<PreviousAppointmentsFilter>("any");
  const [previousAppointmentsByOfficer, setPreviousAppointmentsByOfficer] = useState<
    Record<string, number>
  >({});
  const [appointmentsFor, setAppointmentsFor] = useState<{
    officerId: string;
    name: string;
    currentCompanyNumber: string;
    appointments: OfficerAppointment[] | null;
    loading: boolean;
  } | null>(null);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [helpStepIndex, setHelpStepIndex] = useState(0);
  const [helpStepDirection, setHelpStepDirection] = useState<HelpStepDirection>("forward");
  const renderNowMs = Date.now();
  const tutorialSteps: TutorialStep[] = [
    {
      title: "What this dashboard shows",
      description:
        "This page shows newly processed companies from your pipeline. Summary cards at the top give today's enrichment totals and LinkedIn match rate.",
      graphic: "overview",
    },
    {
      title: "Filter your view quickly",
      description:
        "Use SIC, time window, sort order, and previous appointments filters to narrow results. The count tells you how many companies remain in the current view.",
      graphic: "filters",
    },
    {
      title: "Read the table signals",
      description:
        "Fresh badges and hot-lead tags help prioritize. Confidence shows match quality. Open launches either LinkedIn or a Google fallback search.",
      graphic: "table",
    },
    {
      title: "Download in the format you need",
      description:
        "Click the download icon, then choose XML, CSV, or JSON. Export always uses your current filtered view so you only download relevant rows.",
      graphic: "exports",
    },
    {
      title: "Investigate directors faster",
      description:
        "Use Previous appointments on a director to open history in a focused modal. This helps you qualify risk and experience before outreach.",
      graphic: "actions",
    },
  ];
  const activeHelpStep =
    tutorialSteps[Math.min(helpStepIndex, tutorialSteps.length - 1)] || DEFAULT_TUTORIAL_STEP;

  function goToHelpStep(nextIndex: number) {
    const bounded = Math.max(0, Math.min(tutorialSteps.length - 1, nextIndex));
    if (bounded === helpStepIndex) return;
    setHelpStepDirection(bounded > helpStepIndex ? "forward" : "backward");
    setHelpStepIndex(bounded);
  }

  const todayStats = useMemo(() => {
    const rows = data?.rows ?? [];
    const nowMs = Date.now();
    const enrichedToday = rows.filter((row) => rowIsWithinTimeWindow(row, "today", nowMs)).length;
    const linkedInMatches = rows.filter((row) => {
      if (!rowIsWithinTimeWindow(row, "today", nowMs)) return false;
      return row.has_linkedin === true || Boolean((row.linkedin_url || "").trim());
    }).length;
    const matchRate = enrichedToday > 0 ? (linkedInMatches / enrichedToday) * 100 : 0;
    return { enrichedToday, linkedInMatches, matchRate };
  }, [data?.rows]);

  const filteredRows = useMemo(() => {
    if (!data?.rows) return [];
    const nowMs = Date.now();
    return data.rows
      .filter((row) => rowMatchesSicFilter(row, sicFilter))
      .filter((row) => rowIsWithinTimeWindow(row, timeWindow, nowMs))
      .filter((row) =>
        rowMatchesPreviousAppointmentsFilter(
          row,
          previousAppointmentsFilter,
          previousAppointmentsByOfficer
        )
      )
      .sort((a, b) => {
        if (sortOrder === "confidence_desc") {
          const aConf = rowConfidencePercent(a) ?? -1;
          const bConf = rowConfidencePercent(b) ?? -1;
          if (aConf !== bConf) return bConf - aConf;
          const aTs = rowReferenceMs(a) ?? 0;
          const bTs = rowReferenceMs(b) ?? 0;
          return bTs - aTs;
        }
        if (sortOrder === "date_asc") {
          const aDate = parseIncorporationDateOnly(a.incorporation_date) || "";
          const bDate = parseIncorporationDateOnly(b.incorporation_date) || "";
          if (aDate !== bDate) return aDate.localeCompare(bDate);
          const aTs = rowReferenceMs(a) ?? 0;
          const bTs = rowReferenceMs(b) ?? 0;
          return aTs - bTs;
        }
        const aTs = rowReferenceMs(a) ?? 0;
        const bTs = rowReferenceMs(b) ?? 0;
        return bTs - aTs;
      });
  }, [
    data?.rows,
    sicFilter,
    timeWindow,
    sortOrder,
    previousAppointmentsFilter,
    previousAppointmentsByOfficer,
  ]);

  useEffect(() => {
    let cancelled = false;

    const load = async (initialLoad: boolean) => {
      try {
        if (initialLoad) setLoading(true);
        const res = await fetch("/api/run");
        const json = await res.json();
        if (!res.ok) {
          const msg = json?.error ?? `Request failed (${res.status})`;
          throw new Error(msg);
        }
        if (cancelled) return;
        setData(json as PipelineResult);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (!cancelled && initialLoad) setLoading(false);
      }
    };

    void load(true);
    const intervalId = window.setInterval(() => {
      void load(false);
    }, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!appointmentsFor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAppointmentsFor(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [appointmentsFor]);

  useEffect(() => {
    if (!isExportMenuOpen) return;
    const onClickOutside = (event: MouseEvent) => {
      if (
        exportMenuRef.current &&
        event.target instanceof Node &&
        !exportMenuRef.current.contains(event.target)
      ) {
        setIsExportMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsExportMenuOpen(false);
    };
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isExportMenuOpen]);

  useEffect(() => {
    if (!isHelpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsHelpOpen(false);
        setHelpStepIndex(0);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isHelpOpen]);

  async function loadAppointments(
    officerId: string,
    name: string,
    currentCompanyNumber: string
  ) {
    if (appointmentsFor?.officerId === officerId && appointmentsFor.appointments !== null) {
      setAppointmentsFor(null);
      return;
    }
    setAppointmentsFor({
      officerId,
      name,
      currentCompanyNumber,
      appointments: null,
      loading: true,
    });
    try {
      const res = await fetch(`/api/officers/${encodeURIComponent(officerId)}/appointments`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to load");
      const json = (await res.json()) as { appointments: OfficerAppointment[] };
      const allAppointments = json.appointments ?? [];
      const previousAppointments = allAppointments.filter(
        (a) =>
          (a.appointed_to?.company_number || a.company_number || "").trim() !==
          currentCompanyNumber
      );
      setPreviousAppointmentsByOfficer((prev) => ({
        ...prev,
        [officerId]: previousAppointments.length,
      }));
      setAppointmentsFor({
        officerId,
        name,
        currentCompanyNumber,
        appointments: previousAppointments,
        loading: false,
      });
    } catch {
      setAppointmentsFor((prev) =>
        prev ? { ...prev, appointments: [], loading: false } : null
      );
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto w-full max-w-[96rem] px-2 py-8 sm:px-3 lg:px-4">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">Company Dashboard</h1>
          <button
            type="button"
            aria-label="Open help tutorial"
            title="Help tutorial"
            onClick={() => {
              setHelpStepIndex(0);
              setIsHelpOpen(true);
            }}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-slate-300 bg-white text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            ?
          </button>
        </div>

        {loading && (
          <div className="mt-8 flex items-center gap-3 text-slate-600">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-slate-700" />
            <span>Running pipeline...</span>
          </div>
        )}

        {!loading && error && (
          <div className="mt-8 rounded-md border border-red-200 bg-red-50 p-4 text-red-700">
            Failed to load data: {error}
          </div>
        )}

        {!loading && !error && data && (
          <>
            <p className="mt-4 text-sm text-slate-600">
              Last updated: {new Date(data.updatedAt).toLocaleString()} | Data refreshes every 5
              min | Data retention: 24h | Hot lead = high-confidence LinkedIn match
            </p>

            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-md border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Enriched today
                </p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {todayStats.enrichedToday}
                </p>
              </div>
              <div className="rounded-md border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  LinkedIn matches
                </p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {todayStats.linkedInMatches}
                </p>
              </div>
              <div className="rounded-md border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Match rate
                </p>
                <p className="mt-1 text-2xl font-semibold text-slate-900">
                  {todayStats.matchRate.toFixed(1)}%
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label className="text-sm font-medium text-slate-700">Filter by SIC code(s):</label>
              <input
                type="text"
                placeholder="e.g. 62020, 70229 or 62010"
                value={sicFilter}
                onChange={(e) => setSicFilter(e.target.value)}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <label className="text-sm font-medium text-slate-700">Window:</label>
              <select
                value={timeWindow}
                onChange={(e) => setTimeWindow(e.target.value as TimeWindow)}
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="today">Today (default)</option>
                <option value="24h">Last 24 hours</option>
                <option value="6h">Last 6 hours</option>
                <option value="60m">Last 60 minutes</option>
                <option value="30m">Last 30 minutes</option>
              </select>
              <label className="text-sm font-medium text-slate-700">Sort:</label>
              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as SortOrder)}
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="freshest">Freshest first</option>
                <option value="date_asc">Date ascending</option>
                <option value="confidence_desc">Confidence (high to low)</option>
              </select>
              <label className="text-sm font-medium text-slate-700">
                Previous appointments:
              </label>
              <select
                value={previousAppointmentsFilter}
                onChange={(e) =>
                  setPreviousAppointmentsFilter(
                    e.target.value as PreviousAppointmentsFilter
                  )
                }
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="any">Any</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
              <span className="text-sm text-slate-500">
                Showing {filteredRows.length} of {data.rows.length} companies
              </span>
              <div className="relative" ref={exportMenuRef}>
                <button
                  type="button"
                  title="Download options"
                  aria-label="Download options"
                  aria-haspopup="menu"
                  aria-expanded={isExportMenuOpen}
                  onClick={() => setIsExportMenuOpen((open) => !open)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={filteredRows.length === 0}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-4 w-4"
                    aria-hidden="true"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
                {isExportMenuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 z-20 mt-2 w-36 rounded-md border border-slate-200 bg-white p-1 shadow-lg"
                  >
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        exportRowsToXml(filteredRows);
                        setIsExportMenuOpen(false);
                      }}
                      className="block w-full rounded px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
                    >
                      Export XML
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        exportRowsToCsv(filteredRows);
                        setIsExportMenuOpen(false);
                      }}
                      className="block w-full rounded px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
                    >
                      Export CSV
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        exportRowsToJson(filteredRows);
                        setIsExportMenuOpen(false);
                      }}
                      className="block w-full rounded px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
                    >
                      Export JSON
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
              <table className="w-full min-w-[1200px] table-fixed text-sm">
                <thead className="bg-slate-100 text-left text-slate-700">
                  <tr>
                    <th className="w-[18%] px-3 py-3 font-medium">Company</th>
                    <th className="w-[8%] px-3 py-3 font-medium">Number</th>
                    <th className="w-[11%] px-3 py-3 font-medium">Incorporated</th>
                    <th className="w-[7%] px-3 py-3 font-medium">SIC Codes</th>
                    <th className="w-[7%] px-3 py-3 font-medium">Type</th>
                    <th className="w-[18%] px-3 py-3 font-medium">Registered Office</th>
                    <th className="w-[17%] px-3 py-3 font-medium">Directors</th>
                    <th className="w-[7%] px-3 py-3 font-medium">Confidence</th>
                    <th className="w-[7%] px-3 py-3 font-medium">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row, idx) => {
                    const directorsDetail = parseDirectorsDetail(
                      "directors_detail" in row ? row.directors_detail : undefined
                    );
                    return (
                      <tr
                        key={`${row.company_number}-${idx}`}
                        className={idx % 2 === 0 ? "bg-white" : "bg-slate-50"}
                      >
                        <td className="px-3 py-3 align-top whitespace-normal break-words text-slate-800">
                          <div className="flex flex-wrap items-center gap-2">
                            <span>{row.company_name}</span>
                            {isVeryFresh(row, renderNowMs) && (
                              <span
                                className="inline-block h-2 w-2 rounded-full bg-emerald-500"
                                title="Incorporated within the last 30 minutes"
                                aria-label="Very fresh incorporation"
                              />
                            )}
                            {(() => {
                              const label = freshnessBadgeLabel(row, renderNowMs);
                              if (!label) return null;
                              return (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
                                  {label}
                                </span>
                              );
                            })()}
                            {rowIsHotLead(row) && (
                              <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700">
                                HOT LEAD
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top whitespace-normal break-words text-slate-700">
                          {row.company_number}
                        </td>
                        <td className="px-3 py-3 align-top whitespace-normal break-words text-slate-700">
                          <div className="flex flex-col gap-1">
                            <span>{row.incorporation_date}</span>
                            {(() => {
                              const ago = incorporatedAgoLabel(row, renderNowMs);
                              if (!ago) return null;
                              return <span className="text-xs text-slate-500">{ago}</span>;
                            })()}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top whitespace-normal break-all text-slate-700">
                          {row.sic_codes || "—"}
                        </td>
                        <td className="px-3 py-3 align-top whitespace-normal break-words text-slate-700">
                          {row.company_type}
                        </td>
                        <td className="px-3 py-3 align-top whitespace-normal break-words text-slate-700">
                          {row.registered_office_address || "—"}
                        </td>
                        <td className="px-3 py-3 align-top whitespace-normal break-words text-slate-700">
                          <div className="flex flex-col gap-2">
                            {directorsDetail.length > 0
                              ? directorsDetail.map((d) => (
                                  <span key={d.officer_id} className="flex items-start gap-2">
                                    <span className="min-w-0 flex-1 break-words">{d.name}</span>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        loadAppointments(d.officer_id, d.name, row.company_number)
                                      }
                                      className="shrink-0 text-left text-xs leading-tight text-blue-600 hover:underline"
                                    >
                                      <span className="block">Previous</span>
                                      <span className="block">appointments</span>
                                    </button>
                                  </span>
                                ))
                              : row.directors}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top whitespace-normal break-words text-slate-700">
                          {(() => {
                            const confidence = rowConfidencePercent(row);
                            if (confidence === null) return "—";
                            return `${confidence}%`;
                          })()}
                        </td>
                        <td className="px-3 py-3 align-top text-slate-700">
                          <button
                            type="button"
                            aria-label={`Open link for ${row.company_name}`}
                            title={row.linkedin_url ? "Open LinkedIn profile" : "Search company on Google"}
                            onClick={() => {
                              const targetUrl = row.linkedin_url || buildGoogleCompanySearchUrl(row);
                              window.open(targetUrl, "_blank", "noopener,noreferrer");
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="h-4 w-4"
                              aria-hidden="true"
                            >
                              <circle cx="11" cy="11" r="7" />
                              <line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {appointmentsFor && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                <button
                  type="button"
                  aria-label="Close previous appointments modal"
                  className="absolute inset-0 bg-slate-900/40"
                  onClick={() => setAppointmentsFor(null)}
                />
                <div
                  role="dialog"
                  aria-modal="true"
                  className="relative z-10 max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl"
                >
                  <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                    <h2 className="font-medium text-slate-800">
                      Previous appointments: {appointmentsFor.name}
                    </h2>
                    <button
                      type="button"
                      onClick={() => setAppointmentsFor(null)}
                      className="text-sm text-slate-500 hover:text-slate-700"
                    >
                      Close
                    </button>
                  </div>
                  <div className="max-h-[70vh] overflow-auto p-4">
                    {appointmentsFor.loading ? (
                      <div className="flex items-center gap-2 text-slate-600">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600" />
                        Loading…
                      </div>
                    ) : appointmentsFor.appointments && appointmentsFor.appointments.length > 0 ? (
                      <ul className="space-y-2 text-sm">
                        {appointmentsFor.appointments.map((a, i) => (
                          <li key={i} className="rounded border border-slate-200 bg-slate-50 p-3">
                            <div className="font-medium text-slate-800">
                              {a.appointed_to?.company_name?.trim() ||
                                a.company_name?.trim() ||
                                "Company name not provided"}
                            </div>
                            <div className="mt-1 text-slate-600">
                              Number:{" "}
                              {a.appointed_to?.company_number?.trim() ||
                                a.company_number?.trim() ||
                                "Not provided"}{" "}
                              · Role:{" "}
                              {a.officer_role?.trim() || "Not provided"}
                            </div>
                            <div className="mt-1 text-slate-600">
                              {a.appointed_on ? `From ${a.appointed_on}` : "Start date not provided"}
                              {a.resigned_on ? ` to ${a.resigned_on}` : " (active)"}
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-slate-500">
                        No previous appointments found for this director.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {isHelpOpen && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
                <button
                  type="button"
                  aria-label="Close help modal"
                  className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
                  onClick={() => {
                    setIsHelpOpen(false);
                    setHelpStepIndex(0);
                  }}
                />
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="help-modal-title"
                  className="relative z-10 w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-2xl"
                >
                  <div className="border-b border-slate-200 px-5 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-widest text-blue-600">
                          Tutorial
                        </p>
                        <h2 id="help-modal-title" className="mt-1 text-xl font-semibold text-slate-900">
                          {activeHelpStep.title}
                        </h2>
                        <p className="mt-2 text-sm text-slate-600">{activeHelpStep.description}</p>
                      </div>
                      <button
                        type="button"
                        className="text-sm text-slate-500 hover:text-slate-700"
                        onClick={() => {
                          setIsHelpOpen(false);
                          setHelpStepIndex(0);
                        }}
                      >
                        Close
                      </button>
                    </div>
                  </div>

                  <div className="px-5 py-5">
                    <div
                      key={helpStepIndex}
                      className="will-change-transform"
                      style={{
                        animation:
                          helpStepDirection === "forward"
                            ? "tutorial-slide-right 220ms ease-out"
                            : "tutorial-slide-left 220ms ease-out",
                      }}
                    >
                      {activeHelpStep.graphic === "overview" && (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                          <div className="grid grid-cols-3 gap-3">
                            <div className="rounded border border-slate-200 bg-white p-3">
                              <p className="text-[11px] text-slate-500">Enriched today</p>
                              <p className="mt-1 text-lg font-semibold text-slate-900">17</p>
                            </div>
                            <div className="rounded border border-slate-200 bg-white p-3">
                              <p className="text-[11px] text-slate-500">LinkedIn matches</p>
                              <p className="mt-1 text-lg font-semibold text-slate-900">2</p>
                            </div>
                            <div className="rounded border border-slate-200 bg-white p-3">
                              <p className="text-[11px] text-slate-500">Match rate</p>
                              <p className="mt-1 text-lg font-semibold text-slate-900">11.7%</p>
                            </div>
                          </div>
                          <div className="mt-4 rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
                            <p className="font-medium">Example row snapshot</p>
                            <p className="mt-1">Riverstone Labs Ltd | 16123456 | 62020 | 82%</p>
                          </div>
                        </div>
                      )}

                      {activeHelpStep.graphic === "filters" && (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                          <div className="grid grid-cols-2 gap-3">
                            <div className="rounded border border-slate-200 bg-white p-3 text-xs">
                              <p className="text-slate-500">SIC filter</p>
                              <p className="mt-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-700">
                                62020, 70229
                              </p>
                            </div>
                            <div className="rounded border border-slate-200 bg-white p-3 text-xs">
                              <p className="text-slate-500">Window</p>
                              <p className="mt-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-700">
                                Today
                              </p>
                            </div>
                            <div className="rounded border border-slate-200 bg-white p-3 text-xs">
                              <p className="text-slate-500">Sort</p>
                              <p className="mt-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-700">
                                Confidence (high to low)
                              </p>
                            </div>
                            <div className="rounded border border-slate-200 bg-white p-3 text-xs">
                              <p className="text-slate-500">Previous appointments</p>
                              <p className="mt-2 rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-700">
                                Yes
                              </p>
                            </div>
                          </div>
                          <div className="mt-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                            Showing 5 of 17 companies
                          </div>
                        </div>
                      )}

                      {activeHelpStep.graphic === "table" && (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                          <div className="rounded border border-slate-200 bg-white p-3 text-xs">
                            <div className="grid grid-cols-5 gap-2 font-medium text-slate-500">
                              <div>Company</div>
                              <div>Number</div>
                              <div>SIC</div>
                              <div>Confidence</div>
                              <div>Open</div>
                            </div>
                            <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2">
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-slate-800">Northgate Data Ltd</span>
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                                  NEW 30m
                                </span>
                                <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">
                                  HOT LEAD
                                </span>
                              </div>
                              <p className="mt-1 text-slate-600">16200931 | 62012 | 91%</p>
                            </div>
                          </div>
                        </div>
                      )}

                      {activeHelpStep.graphic === "exports" && (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                          <div className="mx-auto w-56 rounded border border-slate-200 bg-white p-3">
                            <p className="text-xs text-slate-500">Download options</p>
                            <div className="mt-3 space-y-2 text-xs">
                              <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-700">
                                Export XML (for integrations)
                              </div>
                              <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-700">
                                Export CSV (for spreadsheets)
                              </div>
                              <div className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-slate-700">
                                Export JSON (for APIs/scripts)
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {activeHelpStep.graphic === "actions" && (
                        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                          <div className="rounded border border-slate-200 bg-white p-3 text-xs">
                            <p className="font-medium text-slate-700">Directors</p>
                            <div className="mt-3 space-y-2">
                              <div className="flex items-start justify-between rounded border border-slate-200 bg-slate-50 p-2">
                                <span className="text-slate-700">Amelia Hart</span>
                                <span className="text-blue-700">Previous appointments</span>
                              </div>
                              <div className="flex items-start justify-between rounded border border-slate-200 bg-slate-50 p-2">
                                <span className="text-slate-700">Noah Bennett</span>
                                <span className="text-blue-700">Previous appointments</span>
                              </div>
                            </div>
                          </div>
                          <div className="mt-4 rounded border border-slate-200 bg-white p-3 text-xs text-slate-600">
                            Modal opens with prior companies, role, and dates for quick qualification.
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-slate-200 px-5 py-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        {tutorialSteps.map((_, idx) => (
                          <span
                            key={idx}
                            className={`h-2 w-2 rounded-full ${
                              idx === helpStepIndex ? "bg-blue-600" : "bg-slate-300"
                            }`}
                          />
                        ))}
                        <span className="ml-2 text-xs text-slate-500">
                          Step {helpStepIndex + 1} of {tutorialSteps.length}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => goToHelpStep(helpStepIndex - 1)}
                          disabled={helpStepIndex === 0}
                          className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Previous
                        </button>
                        {helpStepIndex < tutorialSteps.length - 1 ? (
                          <button
                            type="button"
                            onClick={() => goToHelpStep(helpStepIndex + 1)}
                            className="rounded border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
                          >
                            Next
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setIsHelpOpen(false);
                              setHelpStepIndex(0);
                            }}
                            className="rounded border border-blue-600 bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
                          >
                            Finish
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
