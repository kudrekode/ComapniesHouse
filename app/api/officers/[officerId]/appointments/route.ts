import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdminClient } from "../../../../../lib/supabaseAdmin";

export async function GET(
  _request: NextRequest,
  context: { params: { officerId: string } }
) {
  const { officerId } = context.params;
  if (!officerId) {
    return NextResponse.json(
      { error: "Missing officer ID" },
      { status: 400 }
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
          return NextResponse.json({ appointments, source: "db-cache" }, { status: 200 });
        }
      } catch {
        // malformed cache; return empty below
      }
    }

    return NextResponse.json(
      { appointments: [], source: "db-miss" },
      { status: 200 }
    );
  } catch (error) {
    console.error("Officer appointments failed:", error);
    return NextResponse.json(
      { error: "Failed to load officer appointments" },
      { status: 500 }
    );
  }
}
