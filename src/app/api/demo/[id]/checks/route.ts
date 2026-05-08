import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/demo/[id]/checks — public final-render fetch for a /demo trial.
 *
 * Returns `{ screening, checks }` in one round-trip. The /status endpoint is
 * for cheap polling; this is the once-and-done render fetch after status
 * goes to `completed`.
 *
 * Same gate as /status: only `is_demo=true` rows within the retention window
 * resolve. Authed screenings stay invisible through this surface.
 */
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

  const { data: screening } = await supabase
    .from("screenings")
    .select("*")
    .eq("id", id)
    .eq("is_demo", true)
    .gte("created_at", since)
    .single();

  if (!screening) {
    return NextResponse.json({ error: "Trial not found or expired" }, { status: 404 });
  }

  const { data: checks } = await supabase
    .from("screening_checks")
    .select("*")
    .eq("screening_id", id)
    .order("checked_at", { ascending: true });

  return NextResponse.json({ screening, checks: checks || [] });
}
