import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedAdminClient: SupabaseClient | null = null;

function readSupabaseUrl(): string {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  if (!url) throw new Error("Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)");
  return url;
}

function readSupabaseServiceKey(): string {
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)");
  return key;
}

export function getSupabaseAdminClient(): SupabaseClient {
  if (cachedAdminClient) return cachedAdminClient;
  cachedAdminClient = createClient(readSupabaseUrl(), readSupabaseServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedAdminClient;
}

