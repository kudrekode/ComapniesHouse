import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "../../../../../lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0, s-maxage=0",
  Pragma: "no-cache",
  Expires: "0",
};

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ officerId: string }> }
) {
  const { officerId } = await context.params;
  if (!officerId) {
    return NextResponse.json(
      { error: "Missing officer ID" },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const supabase = getSupabaseAdminClient();
    const cacheKey = `officer_appointments:${officerId}`;
    const cached = await supabase
      .from("ingest_state")
      .select("value, updated_at")
      .eq("key", cacheKey)
      .maybeSingle<{ value: string; updated_at: string }>();

    if (!cached.error && cached.data) {
      try {
        const appointments = JSON.parse(cached.data.value || "[]");
        if (Array.isArray(appointments)) {
          return NextResponse.json(
            { appointments, source: "db-cache" },
            { status: 200, headers: NO_STORE_HEADERS }
          );
        }
      } catch {
        // malformed cache; return empty below
      }
    }

    return NextResponse.json(
      { appointments: [], source: "db-miss" },
      { status: 200, headers: NO_STORE_HEADERS }
    );
  } catch (error) {
    console.error("Officer appointments failed:", error);
    return NextResponse.json(
      { error: "Failed to load officer appointments" },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
