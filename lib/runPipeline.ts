export type PipelineRow = {
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

export type PipelineResult = {
  updatedAt: string;
  rows: PipelineRow[];
};

export async function runPipeline(): Promise<PipelineResult> {
  // Mocked for now; replace with real pipeline integration.
  return {
    updatedAt: new Date().toISOString(),
    rows: [
      {
        company_name: "VELLURE COUTURE LTD",
        company_number: "17024243",
        incorporation_date: "2026-02-10",
        sic_codes: "14131;14132;14190;47910",
        company_type: "ltd",
        registered_office_address: "287 Wellingborough Road, Northampton, NN1 4EW, England",
        directors: "PETCU, Luciana",
        has_linkedin: false,
        linkedin_url: null,
      },
      {
        company_name: "TASKSNEST LIMITED",
        company_number: "17023429",
        incorporation_date: "2026-02-10",
        sic_codes: "62020",
        company_type: "ltd",
        registered_office_address: "71-75 Shelton Street, Covent Garden, London, WC2H 9JQ, England",
        directors: "ROMANIAK, Pawel",
        has_linkedin: true,
        linkedin_url: "https://www.linkedin.com/company/tasksnest/",
      },
    ],
  };
}
