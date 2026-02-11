import { promises as fs } from "fs";

export type CsvRow = {
  company_name: string;
  company_number: string;
  incorporation_date: string;
  directors: string;
  has_online_presence: boolean;
  website_url: string | undefined;
  linkedin_url: string | undefined;
};

export async function exportToCsv(
  rows: CsvRow[],
  outputPath: string
): Promise<void> {
  const headers = [
    "company_name",
    "company_number",
    "incorporation_date",
    "directors",
    "has_online_presence",
    "website_url",
    "linkedin_url",
  ];

  const lines = [headers.join(",")];

  for (const row of rows) {
    const values = [
      row.company_name,
      row.company_number,
      row.incorporation_date,
      row.directors,
      String(row.has_online_presence),
      row.website_url ?? "",
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
