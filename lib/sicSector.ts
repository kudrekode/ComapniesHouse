export type SectorOption = {
  id: string;
  label: string;
  divisions: Array<[number, number]>;
};

export const SECTOR_OPTIONS: SectorOption[] = [
  { id: "agriculture", label: "Agriculture, Forestry and Fishing", divisions: [[1, 3]] },
  { id: "mining", label: "Mining and Quarrying", divisions: [[5, 9]] },
  { id: "manufacturing", label: "Manufacturing", divisions: [[10, 33]] },
  { id: "utilities", label: "Electricity, Gas, Steam and AC Supply", divisions: [[35, 35]] },
  { id: "water_waste", label: "Water Supply, Sewerage and Waste", divisions: [[36, 39]] },
  { id: "construction", label: "Construction", divisions: [[41, 43]] },
  {
    id: "wholesale_retail",
    label: "Wholesale, Retail and Motor Repair",
    divisions: [[45, 47]],
  },
  { id: "transport", label: "Transportation and Storage", divisions: [[49, 53]] },
  { id: "accommodation_food", label: "Accommodation and Food Service", divisions: [[55, 56]] },
  {
    id: "information_comms",
    label: "Information and Communication",
    divisions: [[58, 63]],
  },
  { id: "finance_insurance", label: "Financial and Insurance Activities", divisions: [[64, 66]] },
  { id: "real_estate", label: "Real Estate Activities", divisions: [[68, 68]] },
  {
    id: "professional_scientific",
    label: "Professional, Scientific and Technical Activities",
    divisions: [[69, 75]],
  },
  { id: "admin_support", label: "Administrative and Support Services", divisions: [[77, 82]] },
  {
    id: "public_admin",
    label: "Public Administration and Defence",
    divisions: [[84, 84]],
  },
  { id: "education", label: "Education", divisions: [[85, 85]] },
  { id: "health_social", label: "Human Health and Social Work", divisions: [[86, 88]] },
  { id: "arts_recreation", label: "Arts, Entertainment and Recreation", divisions: [[90, 93]] },
  { id: "other_services", label: "Other Service Activities", divisions: [[94, 96]] },
  { id: "households", label: "Households as Employers / Own Use", divisions: [[97, 98]] },
  { id: "extraterritorial", label: "Extraterritorial Organisations", divisions: [[99, 99]] },
];

const SECTOR_BY_ID = new Map(SECTOR_OPTIONS.map((option) => [option.id, option]));

function parseSicCodes(raw: string): string[] {
  return raw
    .split(/[\s,;|]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseDivision(code: string): number | null {
  const digits = code.replace(/\D/g, "");
  if (!digits) return null;
  const divisionStr = digits.length >= 2 ? digits.slice(0, 2) : digits;
  const division = Number.parseInt(divisionStr, 10);
  if (!Number.isFinite(division)) return null;
  return division;
}

function matchesDivision(division: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => division >= start && division <= end);
}

export function normalizeSectorFilter(raw: string): string[] {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const deduped = new Set<string>();
  for (const value of values) {
    if (SECTOR_BY_ID.has(value)) deduped.add(value);
  }
  return Array.from(deduped);
}

export function rowMatchesSectorFilter(sicCodesRaw: string | null | undefined, sectorIds: string[]): boolean {
  if (!sectorIds.length) return true;
  const raw = (sicCodesRaw || "").trim();
  if (!raw) return false;
  const selected = sectorIds
    .map((id) => SECTOR_BY_ID.get(id))
    .filter((option): option is SectorOption => Boolean(option));
  if (!selected.length) return true;
  const codes = parseSicCodes(raw);
  for (const code of codes) {
    const division = parseDivision(code);
    if (division === null) continue;
    for (const option of selected) {
      if (matchesDivision(division, option.divisions)) return true;
    }
  }
  return false;
}
