"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { DEMO_MODE } from "../../lib/demoMode";
import { getSupabaseBrowserClient } from "../../lib/supabaseBrowser";

function usernameToEmail(usernameOrEmail: string): string {
  const value = String(usernameOrEmail || "").trim().toLowerCase();
  if (!value) return "";
  if (value.includes("@")) return value;
  const domain = (process.env.NEXT_PUBLIC_LOGIN_EMAIL_DOMAIN || "example.com")
    .trim()
    .toLowerCase();
  return `${value}@${domain}`;
}

export default function LoginPage() {
  const router = useRouter();
  const supabase = useMemo(
    () => (DEMO_MODE ? null : getSupabaseBrowserClient()),
    []
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (DEMO_MODE) {
      router.replace("/");
      return;
    }
    if (!supabase) return;

    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (data.session) router.replace("/");
    })();
    return () => {
      cancelled = true;
    };
  }, [router, supabase]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setError(null);
    setLoading(true);
    try {
      const email = usernameToEmail(username);
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (signInError) throw signInError;
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sign in");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-10 text-slate-900">
      <div className="mx-auto w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {DEMO_MODE ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Local demo mode</h1>
            <p className="mt-2 text-sm text-slate-600">
              No login or Supabase connection is needed to view the synthetic dashboard.
            </p>
            <button
              type="button"
              onClick={() => router.replace("/")}
              className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md border border-blue-600 bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700"
            >
              Open the demo dashboard
            </button>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Dashboard Login</h1>
            <p className="mt-2 text-sm text-slate-600">
              Sign in with your assigned username and password.
            </p>

            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">Username</span>
                <input
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="e.g. admin"
                  required
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-10 w-full rounded-md border border-slate-300 px-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  required
                />
              </label>

              {error && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="inline-flex h-10 w-full items-center justify-center rounded-md border border-blue-600 bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Signing in..." : "Sign in"}
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  );
}
