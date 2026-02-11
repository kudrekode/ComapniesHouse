export type SearchResult = {
  title: string;
  url: string;
};

export type EnrichmentResult = {
  has_online_presence: boolean;
  website_url: string | undefined;
  linkedin_url: string | undefined;
};

type MockSearchData = Record<string, SearchResult[]>;

export class EnrichmentService {
  private mockData: MockSearchData;

  constructor() {
    this.mockData = this.loadMockData();
  }

  async enrichCompany(companyName: string): Promise<EnrichmentResult> {
    const websiteQuery = `${companyName} official website`;
    const linkedinQuery = `${companyName} LinkedIn`;

    const [websiteResults, linkedinResults] = await Promise.all([
      this.search(websiteQuery),
      this.search(linkedinQuery),
    ]);

    const websiteUrl: string | undefined = this.pickLikelyWebsite(websiteResults);
    const linkedinUrl : string | undefined = this.pickLinkedIn(linkedinResults);

    return {
      has_online_presence: Boolean(websiteUrl || linkedinUrl),
      website_url: websiteUrl,
      linkedin_url: linkedinUrl,
    };
  }

  private async search(query: string): Promise<SearchResult[]> {
    // Mocked search API. Replace with a real provider later.
    // You can inject mock results via env var JSON.
    return this.mockData[query] ?? [];
  }

  private pickLikelyWebsite(results: SearchResult[]): string | undefined {
    for (const r of results) {
      const url = this.normalizeUrl(r.url);
      if (!url) continue;

      if (
        url.startsWith("http://") ||
        url.startsWith("https://")
      ) {
        if (!url.includes("linkedin.com")) {
          return url;
        }
      }
    }
    return undefined;
  }

  private pickLinkedIn(results: SearchResult[]): string | undefined {
    for (const r of results) {
      const url = this.normalizeUrl(r.url);
      if (!url) continue;

      if (url.includes("linkedin.com/company/") || url.includes("linkedin.com/")) {
        return url;
      }
    }
    return undefined;
  }

  private normalizeUrl(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    return raw.trim();
  }

  private loadMockData(): MockSearchData {
    const raw = process.env.MOCK_SEARCH_RESULTS_JSON;
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as MockSearchData;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
      return {};
    } catch {
      return {};
    }
  }
}

