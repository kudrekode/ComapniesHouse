import axios from "axios";
import type { AxiosError } from "axios";

export type SearchResult = {
  title: string;
  url: string;
};

export type EnrichmentResult = {
  has_linkedin: boolean;
  linkedin_url: string | null;
};

export class EnrichmentService {
  private apiKey: string;
  private baseUrl: string;
  private maxRetries: number;

  constructor() {
    this.apiKey = process.env.SEARCH_API_KEY || "";
    this.baseUrl = process.env.SEARCH_API_URL || "https://www.searchapi.io/api/v1/search";
    this.maxRetries = Number.parseInt(process.env.SEARCH_MAX_RETRIES || "4", 10);
  }

  async enrichCompany(companyName: string): Promise<EnrichmentResult> {
    if (!this.apiKey) {
      throw new Error("Missing SEARCH_API_KEY");
    }

    const linkedinQuery = `"${companyName}" site:linkedin.com/company`;
    const linkedinResults = await this.searchWithRetry(linkedinQuery);
    const linkedinUrl = this.pickLinkedIn(linkedinResults) ?? null;

    return {
      has_linkedin: Boolean(linkedinUrl),
      linkedin_url: linkedinUrl,
    };
  }

  private async searchWithRetry(query: string): Promise<SearchResult[]> {
    let attempt = 0;

    while (true) {
      try {
        return await this.search(query);
      } catch (err) {
        attempt += 1;
        const axiosErr = err as AxiosError;
        const status = axiosErr.response?.status;
        const retryAfterHeader = axiosErr.response?.headers?.["retry-after"];
        const retryAfterSeconds = retryAfterHeader
          ? Number.parseInt(String(retryAfterHeader), 10)
          : NaN;
        const retryable = status === 429 || (typeof status === "number" && status >= 500);

        if (!retryable || attempt > this.maxRetries) {
          throw err;
        }

        await this.sleep(this.computeBackoffMs(attempt, retryAfterSeconds));
      }
    }
  }

  private async search(query: string): Promise<SearchResult[]> {
    const response = await axios.get(this.baseUrl, {
      timeout: 20_000,
      params: {
        engine: "google",
        q: query,
        api_key: this.apiKey,
      },
    });

    const data = response.data as any;
    const organic = Array.isArray(data?.organic_results)
      ? data.organic_results
      : Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.items)
      ? data.items
      : [];

    if (!Array.isArray(organic)) {
      throw new Error("Search API returned invalid results payload");
    }

    return organic
      .map((item: any) => ({
        title: String(item?.title ?? ""),
        url: String(item?.link ?? item?.url ?? ""),
      }))
      .filter((r: SearchResult) => Boolean(r.url));
  }

  private pickLinkedIn(results: SearchResult[]): string | undefined {
    for (const r of results) {
      const url = this.normalizeUrl(r.url);
      if (!url) continue;

      if (url.includes("linkedin.com/company/")) {
        return url;
      }
    }
    return undefined;
  }

  private normalizeUrl(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname.toLowerCase().includes("linkedin.com")) {
        return undefined;
      }
      if (!parsed.pathname.toLowerCase().includes("/company/")) {
        return undefined;
      }
      return parsed.toString();
    } catch {
      return undefined;
    }
  }

  private computeBackoffMs(attempt: number, retryAfterSeconds: number): number {
    if (!Number.isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }

    const base = 500 * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 250);
    return Math.min(10_000, base + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

