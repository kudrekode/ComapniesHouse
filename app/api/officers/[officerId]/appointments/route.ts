import { NextRequest, NextResponse } from "next/server";
import { CompaniesHouseClient } from "../../../../../companiesHouseClient";

const API_KEY = process.env.COMPANIES_HOUSE_API_KEY || "";

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

  if (!API_KEY) {
    return NextResponse.json(
      { error: "Companies House API key not configured" },
      { status: 500 }
    );
  }

  try {
    const client = new CompaniesHouseClient(API_KEY);
    const appointments = await client.getOfficerAppointments(officerId);
    return NextResponse.json({ appointments }, { status: 200 });
  } catch (error) {
    console.error("Officer appointments failed:", error);
    return NextResponse.json(
      { error: "Failed to load officer appointments" },
      { status: 500 }
    );
  }
}
