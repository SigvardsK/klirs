import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Stale-screening threshold. The fire-and-forget runner can die mid-run if the
// Railway worker is OOM-killed or the platform recycles the process — in that
// case the row sits in `in_progress` indefinitely with no error trail (the
// outer try/catch in screening-engine.ts:451 never gets to run). After this
// many milliseconds without a new screening_checks row, we surface the
// screening as `stalled` so the UI can offer Retry. We do NOT mutate the row
// here — the synthesis is read-only; recovery is explicit via /retry.
//
// Origin: a heavy company-screening sat in_progress for 3 days when the
// fire-and-forget runner died loading UR's heavy SPA on top of stacked heap.
const STALE_AFTER_MS = 5 * 60 * 1000; // 5 min

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: screening, error } = await supabase
    .from("screenings")
    .select("status, checks_completed, checks_total, completed_at, created_at")
    .eq("id", id)
    .eq("created_by", user.id)
    .single();

  if (error || !screening) {
    return NextResponse.json({ error: "Screening not found" }, { status: 404 });
  }

  // Get latest check
  const { data: latestCheck } = await supabase
    .from("screening_checks")
    .select("database_name, category, status, checked_at")
    .eq("screening_id", id)
    .order("checked_at", { ascending: false })
    .limit(1)
    .single();

  // Stale-detection: in_progress (or stuck pending) screenings whose latest
  // activity is older than STALE_AFTER_MS get a synthetic `stalled` status.
  // Doesn't mutate the row — UI surfaces a Retry button which calls /retry.
  let effectiveStatus = screening.status;
  let recoverable = false;
  if (screening.status === "in_progress" || screening.status === "pending") {
    const lastActivityIso = latestCheck?.checked_at || screening.created_at;
    const lastActivityMs = lastActivityIso ? new Date(lastActivityIso).getTime() : Date.now();
    const ageMs = Date.now() - lastActivityMs;
    if (ageMs > STALE_AFTER_MS) {
      effectiveStatus = "stalled";
      recoverable = true;
    }
  }

  return NextResponse.json({
    status: effectiveStatus,
    raw_status: screening.status,
    recoverable,
    checks_completed: screening.checks_completed,
    checks_total: screening.checks_total,
    completed_at: screening.completed_at,
    latest_check: latestCheck || null,
  });
}
