import assert from "node:assert/strict";
import test from "node:test";

import {
  createDemoAppointments,
  createDemoResult,
  createDemoRows,
} from "../lib/demoData.js";

const NOW_MS = Date.parse("2026-10-06T12:00:00.000Z");

test("demo rows are deterministic, synthetic, and contain no outbound URLs", () => {
  const rows = createDemoRows(NOW_MS);

  assert.equal(rows.length, 75);
  assert.equal(rows.filter((row) => row.search_confidence_score != null).length, 10);
  assert.equal(rows.filter((row) => row.has_linkedin).length, 5);
  assert.ok(rows.every((row) => /^DEMO\d{4}$/.test(row.company_number)));
  assert.ok(rows.every((row) => row.linkedin_url === null && row.website_url === null));
});

test("demo result filters and paginates the generated data", () => {
  const rows = createDemoRows(NOW_MS);
  const firstPage = createDemoResult(
    rows,
    {
      page: 1,
      pageSize: 5,
      sicFilter: "62020",
      sectorFilter: [],
      timeWindow: "24h",
      sortOrder: "freshest",
      previousAppointmentsFilter: "any",
    },
    NOW_MS
  );
  const secondPage = createDemoResult(
    rows,
    {
      page: 2,
      pageSize: 5,
      sicFilter: "62020",
      sectorFilter: [],
      timeWindow: "24h",
      sortOrder: "freshest",
      previousAppointmentsFilter: "any",
    },
    NOW_MS
  );

  assert.ok(firstPage.rows.length > 0);
  assert.ok(firstPage.rows.every((row) => row.sic_codes.includes("62020")));
  assert.equal(
    firstPage.rows.some((row) =>
      secondPage.rows.some((candidate) => candidate.company_number === row.company_number)
    ),
    false
  );
});

test("demo summary distinguishes attempts from accepted matches", () => {
  const rows = createDemoRows(NOW_MS);
  const result = createDemoResult(
    rows,
    {
      page: 1,
      pageSize: 25,
      sicFilter: "",
      sectorFilter: [],
      timeWindow: "24h",
      sortOrder: "confidence_desc",
      previousAppointmentsFilter: "any",
    },
    NOW_MS
  );

  assert.equal(result.totalRows, 75);
  assert.equal(result.summary?.enrichmentAttempts, 10);
  assert.equal(result.summary?.linkedInMatches, 5);
});

test("appointment fixtures exist only for the intended synthetic officers", () => {
  assert.equal(createDemoAppointments("demo-officer-00").length, 1);
  assert.equal(createDemoAppointments("demo-officer-01").length, 0);
  assert.equal(createDemoAppointments("real-officer-id").length, 0);
});
