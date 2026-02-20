import nextEnv from "@next/env";
import { getSupabaseAdminClient } from "../lib/supabaseAdmin.js";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const SERPER_API_URL = "https://google.serper.dev/search";
const BATCH_SIZE = 10;
const MAX_SEARCHES_PER_COMPANY = 2;
const LINKEDIN_ACCEPT_THRESHOLD = 70;

type EnrichmentQueueRow = {
  company_number: string;
  score: number | null;
  enrichment_status: string;
  searches_attempted: number | null;
  created_at: string;
  expires_at: string;
};

type CompanyRow = {
  company_number: string;
  company_name: string;
  registered_office_address: string | null;
  directors: string | null;
  directors_detail: string | null;
  has_linkedin: boolean | null;
  linkedin_url: string | null;
};

type SearchResult = {
  title: string;
  url: string;
  description: string;
};

type DirectorsDetailRow = {
  name?: string;
  officer_id?: string;
};

type EnrichmentOutcome = {
  status: "enriched" | "failed" | "skipped_existing";
  reason: string;
  searchesUsed: number;
};

function readSerperApiKey(): string {
  const key = process.env.SERPER_API_KEY || "";
  if (!key) throw new Error("Missing SERPER_API_KEY");
  return key;
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sanitizeQueryTerm(input: string): string {
  return String(input || "")
    .replace(/["']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(input: string): string[] {
  return normalizeText(input).split(/\s+/).filter(Boolean);
}

function toNameCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

export function normalizeDirectorNameForSearch(rawName: string): string {
  const cleaned = String(rawName || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (!cleaned.includes(",")) return toNameCase(cleaned);

  const parts = cleaned
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return toNameCase(cleaned.replace(",", " "));

  const surname = parts[0] || "";
  const givenNames = parts.slice(1).join(" ");
  return toNameCase(`${givenNames} ${surname}`.trim());
}

function normalizeConfidenceScore(score: number): number {
  const mode = String(process.env.CONTACT_CONFIDENCE_MODE || "percent").toLowerCase();
  if (mode === "fraction") return score;
  return Math.round(score * 100);
}

function debugEnabled(targetCompanyNumber: string | null): boolean {
  if (targetCompanyNumber) return true;
  return String(process.env.ENRICH_DEBUG_LOGS || "false").toLowerCase() === "true";
}

function extractDirectorName(company: CompanyRow): string | null {
  const raw = company.directors_detail;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as DirectorsDetailRow[];
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          const name = String(row?.name || "").trim();
          if (name) return name;
        }
      }
    } catch {
      // ignore malformed directors_detail and fallback to directors text
    }
  }

  const directors = String(company.directors || "").trim();
  if (!directors) return null;

  const pieces = directors
    .split(/\s{2,}|;|\|/g)
    .map((p) => p.trim())
    .filter(Boolean);
  if (pieces.length > 0) return pieces[0] ?? null;
  return directors;
}

function isUkPostcode(value: string): boolean {
  return /[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i.test(value);
}

function extractCity(registeredOfficeAddress: string | null): string | null {
  const raw = String(registeredOfficeAddress || "").trim();
  if (!raw) return null;
  const blocked = new Set([
    "united kingdom",
    "england",
    "scotland",
    "wales",
    "northern ireland",
    "uk",
    "great britain",
  ]);
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !blocked.has(p.toLowerCase()))
    .filter((p) => !isUkPostcode(p));
  if (parts.length === 0) return null;
  return parts[parts.length - 1] ?? null;
}

function extractSerperResults(payload: unknown): SearchResult[] {
  const data = payload as {
    organic?: Array<{ title?: string; link?: string; snippet?: string }>;
  };
  const results = Array.isArray(data?.organic) ? data.organic : [];
  return results
    .map((row) => ({
      title: String(row?.title || ""),
      url: String(row?.link || ""),
      description: String(row?.snippet || ""),
    }))
    .filter((row) => Boolean(row.url))
    .slice(0, 5);
}

function extractSerperRawTop5(payload: unknown): unknown[] {
  const data = payload as {
    organic?: unknown[];
  };
  const results = Array.isArray(data?.organic) ? data.organic : [];
  return results.slice(0, 5);
}

function isBlacklistedUrl(url: string): boolean {
  const lower = url.toLowerCase();
  const blocked = [
    "secret-bases",
    "reportingaccounts",
    "companyquery",
    "find-and-update.company-information.service.gov.uk",
    "opencorporates",
  ];
  return blocked.some((term) => lower.includes(term));
}

function isValidLinkedInProfileUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (!host.includes("linkedin.com")) return false;
  if (!u.pathname.toLowerCase().includes("/in/")) return false;
  if (isBlacklistedUrl(u.href)) return false;

  const blacklist = [
    "pub/dir",
    "company/",
    "posts/",
    "feed/",
    "search/",
    "jobs/",
    "secret-bases",
    "reportingaccounts",
    "companyquery",
    "find-and-update",
    "opencorporates",
  ];
  const path = u.pathname.toLowerCase();
  const href = u.href.toLowerCase();
  const search = (u.search || "").toLowerCase();
  for (const term of blacklist) {
    if (path.includes(term) || href.includes(term) || search.includes(term)) return false;
  }
  return true;
}

function nameMatchesLinkedInResult(directorName: string, result: SearchResult): boolean {
  const nameTokens = normalizeText(directorName)
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  if (nameTokens.length === 0) return false;

  const haystack = normalizeText(`${result.title} ${result.description} ${result.url}`);
  const matches = nameTokens.filter((token) => haystack.includes(token)).length;
  return matches >= Math.min(2, nameTokens.length);
}

function cityMatchesResult(city: string | null, result: SearchResult): boolean {
  if (!city) return false;
  const cityNorm = normalizeText(city);
  if (!cityNorm) return false;
  const haystack = normalizeText(result.description);
  return haystack.includes(cityNorm);
}

function companyAppearsInSnippet(companyName: string, result: SearchResult): boolean {
  const snippet = normalizeText(result.description);
  if (!snippet) return false;
  const tokens = normalizeText(
    companyName.replace(/\b(limited|ltd)\b/gi, "")
  )
    .split(/\s+/)
    .filter((t) => t.length >= 4);
  if (tokens.length === 0) return false;
  const matches = tokens.filter((t) => snippet.includes(t)).length;
  return matches >= Math.min(2, tokens.length);
}

function firstAndLastNameMatch(fullName: string, result: SearchResult): boolean {
  const n = words(fullName);
  if (n.length < 2) return false;
  const first = n[0];
  const last = n[n.length - 1];
  if (!first || !last) return false;
  const haystack = normalizeText(`${result.title} ${result.description} ${result.url}`);
  return haystack.includes(first) && haystack.includes(last);
}

function fullNameExactInTitle(fullName: string, result: SearchResult): boolean {
  const needle = normalizeText(fullName);
  if (!needle) return false;
  const title = normalizeText(result.title);
  return title.includes(needle);
}

function leadershipKeywordInSnippet(result: SearchResult): boolean {
  const snippet = normalizeText(result.description);
  if (!snippet) return false;
  return ["founder", "director", "ceo"].some((k) => snippet.includes(k));
}

type LinkedInScore = {
  score: number;
  reasons: string[];
  disqualified: boolean;
  disqualify_reason?: string;
};

const UK_GEO_TERMS = [
  "united kingdom",
  "uk",
  "england",
  "scotland",
  "wales",
  "northern ireland",
  "great britain",
  "britain",
  "london",
];

const NON_UK_GEO_TERMS = [
  "canada",
  "toronto",
  "ontario",
  "usa",
  "united states",
  "turkey",
  "germany",
  "france",
  "spain",
  "italy",
  "india",
  "pakistan",
  "australia",
  "new zealand",
  "uae",
  "dubai",
  "singapore",
];

function containsAny(haystack: string, terms: string[]): boolean {
  return terms.some((t) => haystack.includes(normalizeText(t)));
}

function linkedInDomainWeight(url: string): { delta: number; reason?: string } {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "uk.linkedin.com") {
      return { delta: 10, reason: "uk_linkedin_domain" };
    }
    const m = host.match(/^([a-z]{2})\.linkedin\.com$/);
    if (m && m[1] !== "uk") {
      return { delta: -15, reason: "non_uk_linkedin_domain" };
    }
  } catch {
    // ignore parse errors; URL validity is checked elsewhere
  }
  return { delta: 0 };
}

function scoreLinkedInResult(
  directorName: string,
  city: string | null,
  companyName: string,
  result: SearchResult
): LinkedInScore {
  let score = 0;
  const reasons: string[] = [];
  const snippet = normalizeText(result.description);
  const cityNorm = city ? normalizeText(city) : "";
  const cityMatch = cityNorm ? snippet.includes(cityNorm) : false;
  const ukSignal = containsAny(snippet, UK_GEO_TERMS);
  const nonUkSignal = containsAny(snippet, NON_UK_GEO_TERMS);

  if (fullNameExactInTitle(directorName, result)) {
    score += 40;
    reasons.push("full_name_exact_title");
  }
  if (firstAndLastNameMatch(directorName, result)) {
    score += 20;
    reasons.push("first_last_match");
  }
  if (cityMatch) {
    score += 25;
    reasons.push("city_match");
  } else if (ukSignal) {
    score += 15;
    reasons.push("uk_geo_signal");
  }
  if (nonUkSignal) {
    score -= 25;
    reasons.push("foreign_geo_penalty");
  }
  if (companyAppearsInSnippet(companyName, result)) {
    score += 15;
    reasons.push("company_match");
  }
  if (leadershipKeywordInSnippet(result)) {
    score += 10;
    reasons.push("leadership_keyword");
  }
  const domain = linkedInDomainWeight(result.url);
  if (domain.delta !== 0) {
    score += domain.delta;
    if (domain.reason) reasons.push(domain.reason);
  }

  if (nonUkSignal && !cityMatch && !ukSignal) {
    return {
      score,
      reasons,
      disqualified: true,
      disqualify_reason: "explicit_non_uk_without_uk_signal",
    };
  }
  if (domain.delta < 0 && !cityMatch) {
    return {
      score,
      reasons,
      disqualified: true,
      disqualify_reason: "non_uk_linkedin_domain_without_city_match",
    };
  }

  return { score, reasons, disqualified: false };
}

function confidenceFromScore(score: number): number {
  if (score >= 70) return 0.9;
  if (score >= 60) return 0.8;
  return 0.7;
}

function pickBestLinkedInMatch(
  results: SearchResult[],
  directorName: string,
  city: string | null,
  companyName: string
): { result: SearchResult; score: LinkedInScore } | null {
  let best: { result: SearchResult; score: LinkedInScore } | null = null;
  for (const result of results) {
    if (!isValidLinkedInProfileUrl(result.url)) continue;
    const score = scoreLinkedInResult(directorName, city, companyName, result);
    if (score.disqualified) continue;
    if (!best || score.score > best.score.score) {
      best = { result, score };
    }
  }
  if (!best) return null;
  return best.score.score >= LINKEDIN_ACCEPT_THRESHOLD ? best : null;
}

function debugScoreCandidates(
  companyNumber: string,
  label: string,
  results: SearchResult[],
  directorName: string,
  city: string | null,
  companyName: string
): void {
  const lines = results.map((result, idx) => {
    const valid = isValidLinkedInProfileUrl(result.url);
    const score = scoreLinkedInResult(directorName, city, companyName, result);
    return {
      rank: idx + 1,
      valid_linkedin_profile: valid,
      score: score.score,
      reasons: score.reasons,
      disqualified: score.disqualified,
      disqualify_reason: score.disqualify_reason ?? null,
      title: result.title,
      url: result.url,
    };
  });
  console.log(
    `[EnrichmentCron][Debug] ${companyNumber} ${label}_scored_candidates=${JSON.stringify(lines)}`
  );
}

async function getCompanyByNumber(companyNumber: string): Promise<CompanyRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("companies")
    .select(
      "company_number, company_name, registered_office_address, directors, directors_detail, has_linkedin, linkedin_url"
    )
    .eq("company_number", companyNumber)
    .maybeSingle<CompanyRow>();
  if (error) throw error;
  return data || null;
}

async function updateQueueRow(
  companyNumber: string,
  updates: Partial<Pick<EnrichmentQueueRow, "enrichment_status" | "searches_attempted">>
): Promise<void> {
  const supabase = getSupabaseAdminClient();
  const { error } = await supabase
    .from("enrichment_queue")
    .update(updates)
    .eq("company_number", companyNumber);
  if (error) throw error;
}

async function markQueueFailed(companyNumber: string, searchesAttempted: number): Promise<void> {
  await updateQueueRow(companyNumber, {
    enrichment_status: "failed",
    searches_attempted: searchesAttempted,
  });
}

async function markQueueEnriched(
  companyNumber: string,
  searchesAttempted: number
): Promise<void> {
  await updateQueueRow(companyNumber, {
    enrichment_status: "enriched",
    searches_attempted: searchesAttempted,
  });
}

export async function getPendingEnrichments(
  companyNumber?: string
): Promise<EnrichmentQueueRow[]> {
  const supabase = getSupabaseAdminClient();
  const nowIso = new Date().toISOString();
  let query = supabase
    .from("enrichment_queue")
    .select(
      "company_number, score, enrichment_status, searches_attempted, created_at, expires_at"
    )
    .eq("enrichment_status", "pending")
    .gt("expires_at", nowIso)
    .or("searches_attempted.is.null,searches_attempted.lt.2")
    .order("score", { ascending: false });
  if (companyNumber) {
    query = query.eq("company_number", companyNumber).limit(1);
  } else {
    query = query.limit(BATCH_SIZE);
  }
  const { data, error } = await query;

  if (error) throw error;
  return (data || []) as EnrichmentQueueRow[];
}

export async function searchSerper(
  query: string,
  opts?: { debug?: boolean; companyNumber?: string; label?: string }
): Promise<SearchResult[]> {
  const apiKey = readSerperApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(SERPER_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: query, num: 10, gl: "uk", hl: "en" }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Serper API failed: ${response.status}`);
    }
    const json = (await response.json()) as unknown;
    const parsed = extractSerperResults(json);
    if (opts?.debug) {
      const label = opts.label || "query";
      const company = opts.companyNumber || "unknown";
      console.log(
        `[EnrichmentCron][Debug] ${company} ${label}="${query}" raw_top5=${JSON.stringify(
          extractSerperRawTop5(json)
        )}`
      );
      console.log(
        `[EnrichmentCron][Debug] ${company} ${label}_parsed_top5=${JSON.stringify(parsed)}`
      );
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

export async function processEnrichment(
  item: EnrichmentQueueRow,
  opts: { debug: boolean }
): Promise<EnrichmentOutcome> {
  const currentAttempts = Number(item.searches_attempted || 0);
  if (currentAttempts >= MAX_SEARCHES_PER_COMPANY) {
    await markQueueFailed(item.company_number, currentAttempts);
    return { status: "failed", reason: "max_attempts_reached", searchesUsed: 0 };
  }

  const company = await getCompanyByNumber(item.company_number);
  if (!company) {
    await markQueueFailed(item.company_number, currentAttempts + 1);
    return { status: "failed", reason: "company_missing", searchesUsed: 1 };
  }
  if (
    company.has_linkedin === true ||
    Boolean(String(company.linkedin_url || "").trim())
  ) {
    await markQueueEnriched(item.company_number, currentAttempts);
    return { status: "skipped_existing", reason: "already_has_contact", searchesUsed: 0 };
  }

  const supabase = getSupabaseAdminClient();
  let usedSearches = 0;

  const originalDirectorName = extractDirectorName(company);
  const directorName = originalDirectorName
    ? normalizeDirectorNameForSearch(originalDirectorName)
    : null;
  const city = extractCity(company.registered_office_address);
  if (directorName && currentAttempts + usedSearches < MAX_SEARCHES_PER_COMPANY) {
    const safeDirector = sanitizeQueryTerm(directorName);
    const query = `"${safeDirector}" site:linkedin.com/in/`;
    if (opts.debug) {
      console.log(
        `[EnrichmentCron][Debug] ${item.company_number} original_director_name="${originalDirectorName || ""}" normalized_director_name="${directorName}" final_query="${query}"`
      );
    }
    const results = await searchSerper(query, {
      debug: opts.debug,
      companyNumber: item.company_number,
      label: "query1",
    });
    usedSearches += 1;
    if (opts.debug) {
      debugScoreCandidates(
        item.company_number,
        "query1",
        results,
        directorName,
        city,
        company.company_name
      );
    }

    const best = pickBestLinkedInMatch(results, directorName, city, company.company_name);
    if (best) {
      if (opts.debug) {
        console.log(
          `[EnrichmentCron][Debug] ${item.company_number} query1_best_score=${best.score.score} reasons=${best.score.reasons.join("|")} url=${best.result.url}`
        );
      }
      const confidence = confidenceFromScore(best.score.score);
      const { error } = await supabase
        .from("companies")
        .update({
          linkedin_url: best.result.url,
          has_linkedin: true,
          contact_confidence: normalizeConfidenceScore(confidence),
          contact_source: "serper_search",
        })
        .eq("company_number", item.company_number);
      if (error) throw error;
      await markQueueEnriched(item.company_number, currentAttempts + usedSearches);
      return {
        status: "enriched",
        reason: `linkedin_scored_${best.score.score}`,
        searchesUsed: usedSearches,
      };
    }
  }

  if (directorName && currentAttempts + usedSearches < MAX_SEARCHES_PER_COMPANY) {
    const safeDirector = sanitizeQueryTerm(directorName);
    const query = city
      ? `"${safeDirector}" "${sanitizeQueryTerm(city)}" site:linkedin.com/in/`
      : `"${safeDirector}" "${sanitizeQueryTerm(company.company_name)}" site:linkedin.com/in/`;
    if (opts.debug) {
      console.log(
        `[EnrichmentCron][Debug] ${item.company_number} original_director_name="${originalDirectorName || ""}" normalized_director_name="${directorName}" final_query="${query}"`
      );
    }
    const results = await searchSerper(query, {
      debug: opts.debug,
      companyNumber: item.company_number,
      label: "query2",
    });
    usedSearches += 1;
    if (opts.debug) {
      debugScoreCandidates(
        item.company_number,
        "query2",
        results,
        directorName,
        city,
        company.company_name
      );
    }
    const best = pickBestLinkedInMatch(results, directorName, city, company.company_name);
    if (best) {
      if (opts.debug) {
        console.log(
          `[EnrichmentCron][Debug] ${item.company_number} query2_best_score=${best.score.score} reasons=${best.score.reasons.join("|")} url=${best.result.url}`
        );
      }
      const confidence = confidenceFromScore(best.score.score);
      const { error } = await supabase
        .from("companies")
        .update({
          linkedin_url: best.result.url,
          has_linkedin: true,
          contact_confidence: normalizeConfidenceScore(confidence),
          contact_source: "serper_search",
        })
        .eq("company_number", item.company_number);
      if (error) throw error;
      await markQueueEnriched(item.company_number, currentAttempts + usedSearches);
      return {
        status: "enriched",
        reason: `linkedin_scored_${best.score.score}`,
        searchesUsed: usedSearches,
      };
    }
  }

  await markQueueFailed(item.company_number, currentAttempts + usedSearches);
  return { status: "failed", reason: "no_usable_search_results", searchesUsed: usedSearches };
}

function parseTargetCompanyNumber(): string | null {
  const companyArg = process.argv.find((arg) => arg.startsWith("--company="));
  if (companyArg) {
    const value = companyArg.slice("--company=".length).trim();
    return value || null;
  }
  const companyArgIndex = process.argv.findIndex((arg) => arg === "--company");
  if (companyArgIndex >= 0) {
    const value = String(process.argv[companyArgIndex + 1] || "").trim();
    return value || null;
  }

  const npmCompany = String(process.env.npm_config_company || "").trim();
  if (npmCompany) return npmCompany;
  const npmCompanyNumber = String(process.env.npm_config_company_number || "").trim();
  if (npmCompanyNumber) return npmCompanyNumber;

  const envValue = String(process.env.ENRICH_COMPANY_NUMBER || "").trim();
  return envValue || null;
}

export async function runCronBatch(): Promise<void> {
  const targetCompanyNumber = parseTargetCompanyNumber();
  const debug = debugEnabled(targetCompanyNumber);
  const pending = await getPendingEnrichments(targetCompanyNumber || undefined);
  if (pending.length === 0) {
    if (targetCompanyNumber) {
      console.log(
        `[EnrichmentCron] No eligible pending row for company ${targetCompanyNumber}`
      );
    } else {
      console.log("[EnrichmentCron] No pending rows");
    }
    return;
  }

  console.log(
    `[EnrichmentCron] Processing ${pending.length} queue row(s)${
      targetCompanyNumber ? ` for ${targetCompanyNumber}` : ""
    }`
  );
  for (const item of pending) {
    try {
      const outcome = await processEnrichment(item, { debug });
      console.log(
        `[EnrichmentCron] ${item.company_number}: ${outcome.status} (${outcome.reason}), searches=${outcome.searchesUsed}`
      );
    } catch (error) {
      const currentAttempts = Number(item.searches_attempted || 0);
      const nextAttempts = Math.min(MAX_SEARCHES_PER_COMPANY, currentAttempts + 1);
      try {
        await markQueueFailed(item.company_number, nextAttempts);
      } catch (updateError) {
        console.error(
          `[EnrichmentCron] Failed updating queue status for ${item.company_number}:`,
          updateError
        );
      }
      console.error(`[EnrichmentCron] Failed ${item.company_number}:`, error);
    }
  }
}

runCronBatch().catch((error) => {
  console.error("[EnrichmentCron] Fatal error:", error);
  process.exitCode = 1;
});
