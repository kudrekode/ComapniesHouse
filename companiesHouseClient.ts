import axios from "axios";
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";

export type CompanySearchItem = {
  company_name: string;
  company_number: string;
  company_status?: string;
  date_of_creation?: string;
};

export type RegisteredOfficeAddress = {
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
  premises?: string;
};

export type CompanyProfile = {
  company_name: string;
  company_number: string;
  date_of_creation?: string;
  company_status?: string;
  type?: string;
  sic_codes?: string[];
  registered_office_address?: RegisteredOfficeAddress;
};

export type OfficerItem = {
  name?: string;
  officer_role?: string;
  appointed_on?: string;
  resigned_on?: string | null;
  links?: {
    officer?: { appointments?: string };
    self?: string;
  };
};

/** One appointment in a director's history (company + role + dates). */
export type OfficerAppointmentItem = {
  company_name?: string;
  company_number?: string;
  company_status?: string;
  appointed_to?: {
    company_name?: string;
    company_number?: string;
    company_status?: string;
  };
  appointed_on?: string;
  resigned_on?: string | null;
  officer_role?: string;
  appointed_before?: string;
  links?: {
    company?: string;
  };
};

type OfficerAppointmentsListResponse = {
  items?: OfficerAppointmentItem[];
  total_results?: number;
  items_per_page?: number;
  start_index?: number;
};

type AdvancedSearchResponse = {
  items?: CompanySearchItem[];
  hits?: number;
};

type OfficersListResponse = {
  items?: OfficerItem[];
  total_results?: number;
  items_per_page?: number;
  start_index?: number;
};

export class CompaniesHouseClient {
  private http: AxiosInstance;
  private maxRetries: number;

  constructor(
    apiKey: string,
    maxRetries = Number.parseInt(process.env.CH_MAX_RETRIES || "6", 10)
  ) {
    if (!apiKey) {
      throw new Error("Missing COMPANIES_HOUSE_API_KEY");
    }

    this.http = axios.create({
      baseURL: "https://api.company-information.service.gov.uk",
      auth: {
        username: apiKey,
        password: "",
      },
      timeout: 30_000,
    });

    this.maxRetries = maxRetries;
  }

  /**
   * Search companies incorporated between two dates.
   * @param maxResults - Optional cap per run. Use 0 or omit to fetch all (no limit).
   */
  async searchCompaniesIncorporatedBetween(
    fromDate: string,
    toDate: string,
    pageSize = 100,
    maxResults?: number
  ): Promise<CompanySearchItem[]> {
    const results: CompanySearchItem[] = [];
    let startIndex = 0;
    const limit = typeof maxResults === "number" && maxResults > 0 ? maxResults : null;

    while (true) {
      const response = await this.requestWithRetry<AdvancedSearchResponse>({
        method: "GET",
        url: "/advanced-search/companies",
        params: {
          incorporated_from: fromDate,
          incorporated_to: toDate,
          size: pageSize,
          start_index: startIndex,
        },
      });

      const items = response.data.items ?? [];
      results.push(...items);

      if (items.length < pageSize) break;
      if (limit !== null && results.length >= limit) break;

      startIndex += pageSize;
      if (limit !== null && startIndex >= limit) break;
    }

    return limit !== null ? results.slice(0, limit) : results;
  }

  async getCompanyProfile(companyNumber: string): Promise<CompanyProfile> {
    const response = await this.requestWithRetry<CompanyProfile>({
      method: "GET",
      url: `/company/${encodeURIComponent(companyNumber)}`,
    });
    return response.data;
  }

  async getCompanyOfficers(companyNumber: string): Promise<OfficerItem[]> {
    const results: OfficerItem[] = [];
    let startIndex = 0;
    const pageSize = 100;

    while (true) {
      const response = await this.requestWithRetry<OfficersListResponse>({
        method: "GET",
        url: `/company/${encodeURIComponent(companyNumber)}/officers`,
        params: {
          items_per_page: pageSize,
          start_index: startIndex,
        },
      });

      const items = response.data.items ?? [];
      results.push(...items);

      if (items.length < pageSize) {
        break;
      }

      startIndex += pageSize;
    }

    return results;
  }

  /**
   * List all appointments for an officer (director) across all companies.
   * Use officer_id from company officers list links.officer.appointments (path segment).
   */
  async getOfficerAppointments(officerId: string): Promise<OfficerAppointmentItem[]> {
    const results: OfficerAppointmentItem[] = [];
    let startIndex = 0;
    const pageSize = 100;

    while (true) {
      const response = await this.requestWithRetry<OfficerAppointmentsListResponse>({
        method: "GET",
        url: `/officers/${encodeURIComponent(officerId)}/appointments`,
        params: {
          items_per_page: pageSize,
          start_index: startIndex,
        },
      });

      const items = response.data.items ?? [];
      results.push(...items);

      if (items.length < pageSize) {
        break;
      }

      startIndex += pageSize;
    }

    return results;
  }

  private async requestWithRetry<T>(
    config: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    let attempt = 0;
    while (true) {
      try {
        return await this.http.request<T>(config);
      } catch (err: any) {
        attempt += 1;

        const status = err?.response?.status;
        const retryAfterHeader = err?.response?.headers?.["retry-after"];
        const rateLimitResetHeader = err?.response?.headers?.["x-ratelimit-reset"];
        const retryAfterSeconds = retryAfterHeader
          ? Number.parseInt(retryAfterHeader, 10)
          : NaN;
        const rateLimitResetEpochSeconds = rateLimitResetHeader
          ? Number.parseInt(rateLimitResetHeader, 10)
          : NaN;

        if (attempt > this.maxRetries || (status && status < 500 && status !== 429)) {
          throw err;
        }

        const backoffMs = this.computeBackoffMs(
          attempt,
          retryAfterSeconds,
          rateLimitResetEpochSeconds
        );
        await this.sleep(backoffMs);
      }
    }
  }

  private computeBackoffMs(
    attempt: number,
    retryAfterSeconds: number,
    rateLimitResetEpochSeconds: number
  ): number {
    // Companies House provides x-ratelimit-reset as epoch seconds.
    // If present, wait until the reset boundary before retrying.
    if (!Number.isNaN(rateLimitResetEpochSeconds) && rateLimitResetEpochSeconds > 0) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const waitSeconds = rateLimitResetEpochSeconds - nowSeconds;
      if (waitSeconds > 0) {
        return (waitSeconds + 1) * 1000;
      }
    }

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
