import { NextResponse } from "next/server";
import { getSupabaseAdminClient } from "../../../lib/supabaseAdmin";
import type { PipelineResult, PipelineRow } from "../../../lib/runPipeline";

export const dynamic = "force-dynamic";

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

export async function GET() {
  try {
    const supabase = getSupabaseAdminClient();

    const [rowsResult, stateResult] = await Promise.all([
      supabase
        .from("companies")
        .select(
          "company_name, company_number, incorporation_date, first_seen_at, has_previous_appointments, previous_appointments_count, sic_codes, company_type, registered_office_address, directors, directors_detail, has_linkedin, linkedin_url, website_url, contact_confidence, contact_source, search_confidence_score, search_confidence_reasons, search_disqualified, search_disqualify_reason"
        )
        .order("last_seen_at", { ascending: false }),
      supabase
        .from("ingest_state")
        .select("value")
        .eq("key", "last_processed_at")
        .maybeSingle<{ value: string }>(),
    ]);

    if (rowsResult.error) throw rowsResult.error;
    if (stateResult.error) throw stateResult.error;

    const rows = (rowsResult.data || []).map(toPipelineRow);
    const updatedAt = stateResult.data?.value || new Date().toISOString();
    const result: PipelineResult = { updatedAt, rows };

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("DB read failed:", error);
    return NextResponse.json(
      { error: "Failed to load dashboard data" },
      { status: 500 }
    );
  }
}
