const demoOverride = process.env.NEXT_PUBLIC_DEMO_MODE;

/**
 * The public repository is an offline synthetic demo by default in every
 * environment. Connected Supabase mode must be selected explicitly with
 * NEXT_PUBLIC_DEMO_MODE=false and the required credentials.
 */
export const DEMO_MODE = demoOverride !== "false";
