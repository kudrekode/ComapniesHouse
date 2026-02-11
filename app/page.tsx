"use client";

import { useEffect, useState } from "react";
import type { PipelineResult } from "../lib/runPipeline";

export default function DashboardPage() {
  const [data, setData] = useState<PipelineResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch("/api/run", { cache: "no-store" });
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        const json = (await res.json()) as PipelineResult;
        setData(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, []);

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
              Last updated: {new Date(data.updatedAt).toLocaleString()}
            </p>

            <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-100 text-left text-slate-700">
                  <tr>
                    <th className="px-4 py-3 font-medium">Company</th>
                    <th className="px-4 py-3 font-medium">Number</th>
                    <th className="px-4 py-3 font-medium">Incorporated</th>
                    <th className="px-4 py-3 font-medium">SIC Codes</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Registered Office</th>
                    <th className="px-4 py-3 font-medium">Directors</th>
                    <th className="px-4 py-3 font-medium">LinkedIn</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row, idx) => (
                    <tr
                      key={`${row.company_number}-${idx}`}
                      className={idx % 2 === 0 ? "bg-white" : "bg-slate-50"}
                    >
                      <td className="px-4 py-3">{row.company_name}</td>
                      <td className="px-4 py-3">{row.company_number}</td>
                      <td className="px-4 py-3">{row.incorporation_date}</td>
                      <td className="px-4 py-3">{row.sic_codes}</td>
                      <td className="px-4 py-3">{row.company_type}</td>
                      <td className="px-4 py-3">{row.registered_office_address}</td>
                      <td className="px-4 py-3">{row.directors}</td>
                      <td className="px-4 py-3">
                        {row.has_linkedin && row.linkedin_url ? (
                          <a
                            href={row.linkedin_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:text-blue-800 hover:underline"
                          >
                            View
                          </a>
                        ) : (
                          <span className="text-slate-500">No</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

