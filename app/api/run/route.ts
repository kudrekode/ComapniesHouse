import { NextResponse } from "next/server";
import { runPipeline } from "../../../lib/runPipeline";

export async function GET() {
  try {
    const result = await runPipeline();
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error("Pipeline failed:", error);
    return NextResponse.json(
      { error: "Failed to run pipeline" },
      { status: 500 }
    );
  }
}

