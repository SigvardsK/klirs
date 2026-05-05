import { createBrowserClient } from "@supabase/ssr";

// Brave Shields (aggressive) denies navigator.locks.request() with
// SecurityError: "The request was denied." Stack pinpointed in
// GoTrueClient.onAuthStateChange → _acquireLock → this.lock(...).
// Override with a no-op — single-tab session-refresh races are acceptable
// for our use case; Brave / Firefox-strict / Safari-ITP buyers regain
// access. Companion to LR-WS-2026-029 (auth-init Brave fix).
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        lock: async <R>(_name: string, _timeout: number, fn: () => Promise<R>) =>
          fn(),
      },
    }
  );
}
