import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/demo/[id]/status — public status poll for a /demo trial.
 *
 * Mirrors /api/screenings/[id]/status but without auth. Filters strictly to
 * `is_demo=true` and `created_at > now() - 24h` so we never expose authed
 * screenings via this surface, and trial rows past the retention window stop
 * resolving.
 *
 * Returns `completed_checks` (full rows, including `screenshot_path`) so the
 * LiveProgress UI can render the per-source waterfall + screenshots as each
 * check completes — without waiting for the final /checks fetch. Empty array
 * (NOT null) when no checks have completed yet (LR-WS-2026-029).
 *
 * Stale-detection: same 5-min threshold as the authed endpoint. If the
 * fire-and-forget runner crashes, the row sits in `in_progress` forever; we
 * synthesize `stalled` so the UI can render a clean error instead of an
 * eternal spinner.
 */
const STALE_AFTER_MS = 5 * 60 * 1000; // 5 min
const RETENTION_HOURS = 24;

function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = getAdminClient();
  const since = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString();

  const { data: screening, error } = await supabase
    .from("screenings")
    .select("status, checks_completed, checks_total, completed_at, created_at, is_demo")
    .eq("id", id)
    .eq("is_demo", true)
    .gte("created_at", since)
    .single();

  if (error || !screening) {
    return NextResponse.json({ error: "Trial not found or expired" }, { status: 404 });
  }

  const { data: completedChecksRaw } = await supabase
    .from("screening_checks")
    .select("*")
    .eq("screening_id", id)
    .order("checked_at", { ascending: true });

  const completed_checks = completedChecksRaw ?? [];
  const latestCheck = completed_checks.length
    ? completed_checks[completed_checks.length - 1]
    : null;

  let effectiveStatus = screening.status;
  let recoverable = false;
  if (screening.status === "in_progress" || screening.status === "pending") {
    const lastActivityIso = latestCheck?.checked_at || screening.created_at;
    const lastActivityMs = lastActivityIso ? new Date(lastActivityIso).getTime() : Date.now();
    const ageMs = Date.now() - lastActivityMs;
    if (ageMs > STALE_AFTER_MS) {
      effectiveStatus = "stalled";
      recoverable = false; // No public retry; user must rerun (counts against rate limit)
    }
  }

  return NextResponse.json({
    status: effectiveStatus,
    raw_status: screening.status,
    recoverable,
    checks_completed: screening.checks_completed,
    checks_total: screening.checks_total,
    completed_at: screening.completed_at,
    latest_check: latestCheck
      ? {
          database_name: latestCheck.database_name,
          category: latestCheck.category,
          status: latestCheck.status,
          checked_at: latestCheck.checked_at,
        }
      : null,
    completed_checks,
  });
}
