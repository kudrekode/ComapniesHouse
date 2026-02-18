"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedBrowserClient: SupabaseClient | null = null;

function readPublicSupabaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  return url;
}

function readPublicSupabaseKey(): string {
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
    "";
  if (!key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY (or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)"
    );
  }
  return key;
}

export function getSupabaseBrowserClient(): SupabaseClient {
  if (cachedBrowserClient) return cachedBrowserClient;
  cachedBrowserClient = createClient(readPublicSupabaseUrl(), readPublicSupabaseKey());
  return cachedBrowserClient;
}

