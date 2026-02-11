import { promises as fs } from "fs";

export type CsvRow = {
  company_name: string;
  company_number: string;
  incorporation_date: string;
  sic_codes: string;
  company_type: string;
  registered_office_address: string;
  directors: string;
  has_linkedin: boolean;
  linkedin_url: string | null;
};

export async function exportToCsv(
  rows: CsvRow[],
  outputPath: string
): Promise<void> {
  const headers = [
    "company_name",
    "company_number",
    "incorporation_date",
    "sic_codes",
    "company_type",
    "registered_office_address",
    "directors",
    "has_linkedin",
    "linkedin_url",
  ];

  const lines = [headers.join(",")];

  for (const row of rows) {
    const values = [
      row.company_name,
      row.company_number,
      row.incorporation_date,
      row.sic_codes,
      row.company_type,
      row.registered_office_address,
      row.directors,
      String(row.has_linkedin),
      row.linkedin_url ?? "",
    ];

    lines.push(values.map(csvEscape).join(","));
  }

  await fs.writeFile(outputPath, lines.join("\n"), "utf8");
}

function csvEscape(value: string): string {
  if (value.includes('"')) {
    value = value.replace(/"/g, '""');
  }
  if (value.includes(",") || value.includes("\n") || value.includes("\r")) {
    return `"${value}"`;
  }
  return value;
}
