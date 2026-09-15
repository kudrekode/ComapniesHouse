const publicSupabaseKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

/** Use the local demo automatically when the public Supabase credentials are absent. */
const missingSupabaseConfig = !process.env.NEXT_PUBLIC_SUPABASE_URL || !publicSupabaseKey;
const demoOverride = process.env.NEXT_PUBLIC_DEMO_MODE;

export const DEMO_MODE =
  demoOverride === "true" ||
  (demoOverride !== "false" && process.env.NODE_ENV !== "production" && missingSupabaseConfig);
