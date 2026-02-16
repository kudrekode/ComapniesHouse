"use client";

import { useEffect, useState, useMemo } from "react";
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

export default function DashboardPage() {
  const [data, setData] = useState<PipelineResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sicFilter, setSicFilter] = useState("");
  const [appointmentsFor, setAppointmentsFor] = useState<{
    officerId: string;
    name: string;
    currentCompanyNumber: string;
    appointments: OfficerAppointment[] | null;
    loading: boolean;
  } | null>(null);

  const filteredRows = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows.filter((row) => rowMatchesSicFilter(row, sicFilter));
  }, [data?.rows, sicFilter]);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch("/api/run", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) {
          const msg = json?.error ?? `Request failed (${res.status})`;
          throw new Error(msg);
        }
        setData(json as PipelineResult);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, []);

  useEffect(() => {
    if (!appointmentsFor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAppointmentsFor(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [appointmentsFor]);

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
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Company Dashboard</h1>

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
              Last updated: {new Date(data.updatedAt).toLocaleString()} · Data refreshes every 5
              min, cache TTL 30 min
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <label className="text-sm font-medium text-slate-700">Filter by SIC code(s):</label>
              <input
                type="text"
                placeholder="e.g. 62020, 70229 or 62010"
                value={sicFilter}
                onChange={(e) => setSicFilter(e.target.value)}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {sicFilter.trim() && (
                <span className="text-sm text-slate-500">
                  Showing {filteredRows.length} of {data.rows.length} companies
                </span>
              )}
            </div>

            <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
              <table className="min-w-full table-fixed text-sm">
                <thead className="bg-slate-100 text-left text-slate-700">
                  <tr>
                    <th className="w-[16%] px-4 py-3 font-medium">Company</th>
                    <th className="w-[10%] px-4 py-3 font-medium">Number</th>
                    <th className="w-[10%] px-4 py-3 font-medium">Incorporated</th>
                    <th className="w-[13%] px-4 py-3 font-medium">SIC Codes</th>
                    <th className="w-[8%] px-4 py-3 font-medium">Type</th>
                    <th className="w-[22%] px-4 py-3 font-medium">Registered Office</th>
                    <th className="w-[21%] px-4 py-3 font-medium">Directors</th>
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
                        <td className="px-4 py-3 align-top whitespace-normal break-words text-slate-800">
                          {row.company_name}
                        </td>
                        <td className="px-4 py-3 align-top whitespace-normal break-words text-slate-700">
                          {row.company_number}
                        </td>
                        <td className="px-4 py-3 align-top whitespace-normal break-words text-slate-700">
                          {row.incorporation_date}
                        </td>
                        <td className="px-4 py-3 align-top whitespace-normal break-words text-slate-700">
                          {row.sic_codes || "—"}
                        </td>
                        <td className="px-4 py-3 align-top whitespace-normal break-words text-slate-700">
                          {row.company_type}
                        </td>
                        <td className="px-4 py-3 align-top whitespace-normal break-words text-slate-700">
                          {row.registered_office_address || "—"}
                        </td>
                        <td className="px-4 py-3 align-top whitespace-normal break-words text-slate-700">
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
          </>
        )}
      </div>
    </main>
  );
}
