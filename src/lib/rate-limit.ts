/**
 * Rate-limiter for unauth /demo trials.
 *
 * Why this exists: the /demo surface lets visitors run a real screening without
 * authenticating (positioning amplifier — see audit-wedge thesis). Without a
 * limit, an attacker can drive arbitrary engine cost. Tighten by hashed IP +
 * sliding 24h window.
 *
 * Privacy contract: we hash IP + a server-side pepper before storing. Raw IPs
 * never touch the DB. The pepper rotates only on incident response (i.e. very
 * rarely) — rotating it invalidates all existing rate-limit counts (everyone
 * gets a fresh 1/24h budget).
 *
 * Composes with LR-WS-2026-029 (UNCERTAIN-not-CLEAR defaults at trust boundaries):
 * if the pepper is missing, we FAIL CLOSED, not OPEN — refuse the run rather than
 * let it through unmetered.
 */

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const DEMO_RUNS_PER_DAY = 2;
const WINDOW_MS = 24 * 60 * 60 * 1000;

function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
}

/**
 * Hash a raw IP with the server-side pepper. Throws if pepper missing — caller
 * MUST treat throw as "fail closed; refuse the run." Don't catch and proceed.
 */
export function hashIp(ip: string): string {
  const pepper = process.env.DEMO_RATE_LIMIT_PEPPER;
  if (!pepper) {
    throw new Error(
      "DEMO_RATE_LIMIT_PEPPER not set — refusing to rate-limit unauth runs without it"
    );
  }
  return createHash("sha256").update(`${ip}:${pepper}`).digest("hex");
}

/**
 * Best-effort client-IP extraction. Railway / Cloudflare set
 * x-forwarded-for; respect the leftmost entry (the original client) and
 * fall back to a known-bad sentinel if missing so the rate-limit ledger
 * still records something traceable.
 */
export function clientIpFrom(headers: Headers): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const cfConnecting = headers.get("cf-connecting-ip");
  if (cfConnecting) return cfConnecting;
  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp;
  return "0.0.0.0";
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number | null;
}

/**
 * Count demo runs in the last 24h for this ip_hash. If under the cap, record
 * a new run. If over, reject. Single-roundtrip would need a DB function;
 * two-roundtrip read-then-write is fine for trial scale (low traffic).
 *
 * NOTE: this records the screening_id only AFTER the screening row is created
 * upstream — `recordRun` is the second call. `checkLimit` is a non-mutating
 * peek for early refusal.
 */
export async function checkLimit(ipHash: string): Promise<RateLimitResult> {
  const supabase = getAdminClient();
  const since = new Date(Date.now() - WINDOW_MS).toISOString();

  const { count, error } = await supabase
    .from("demo_trial_runs")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("created_at", since);

  if (error) {
    // Fail closed on DB error — same logic as missing pepper. Refuse the run.
    return { allowed: false, remaining: 0, retryAfterSeconds: WINDOW_MS / 1000 };
  }

  const used = count ?? 0;
  const remaining = Math.max(0, DEMO_RUNS_PER_DAY - used);
  return {
    allowed: used < DEMO_RUNS_PER_DAY,
    remaining,
    retryAfterSeconds: used >= DEMO_RUNS_PER_DAY ? Math.ceil(WINDOW_MS / 1000) : null,
  };
}

/**
 * Record a successful run. Call AFTER the screening row is created.
 */
export async function recordRun(args: {
  ipHash: string;
  screeningId: string;
  subjectName: string;
}): Promise<void> {
  const supabase = getAdminClient();
  await supabase.from("demo_trial_runs").insert({
    ip_hash: args.ipHash,
    screening_id: args.screeningId,
    subject_name: args.subjectName,
  });
}

export const RATE_LIMIT_CONFIG = {
  runsPerWindow: DEMO_RUNS_PER_DAY,
  windowSeconds: WINDOW_MS / 1000,
} as const;
