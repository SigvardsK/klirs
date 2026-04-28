/**
 * Retry a stalled / failed / stuck-in_progress screening.
 *
 * Resets the row to `pending`, wipes existing screening_checks rows + storage
 * objects so the UI doesn't show stale results from the partial first run,
 * then re-launches `runScreening` exactly like /run does.
 *
 * Owner-only. Idempotent within reason — calling again on a `completed`
 * screening returns 400 (we don't want to clobber a finished result).
 *
 * Origin: a heavy company-screening sat in_progress for 3 days when the
 * fire-and-forget Playwright runner died silently mid-UR (likely OOM /
 * Chromium recycle on Railway). Pairs with the /status stalled-watchdog.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { runScreening, calculateTotalChecks } from "@/lib/screening-engine";
import type { Person } from "@/lib/types";

function getAdminClient() {
  return createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Owner check + load.
  const { data: screening, error } = await supabase
    .from("screenings")
    .select("*")
    .eq("id", id)
    .eq("created_by", user.id)
    .single();

  if (error || !screening) {
    return NextResponse.json({ error: "Screening not found" }, { status: 404 });
  }

  if (screening.status === "completed") {
    return NextResponse.json(
      { error: "Cannot retry a completed screening" },
      { status: 400 }
    );
  }

  const admin = getAdminClient();

  // Wipe existing screening_checks rows AND their evidence-screenshot files
  // — partial first-run results would otherwise stack up alongside the new
  // run's rows and confuse the Checks tab.
  const { data: existingChecks } = await admin
    .from("screening_checks")
    .select("screenshot_path")
    .eq("screening_id", id);

  const screenshotsToDelete = (existingChecks || [])
    .map(c => c.screenshot_path)
    .filter((p): p is string => !!p);

  if (screenshotsToDelete.length > 0) {
    await admin.storage.from("evidence-screenshots").remove(screenshotsToDelete);
  }

  await admin.from("screening_checks").delete().eq("screening_id", id);

  // Reset the row to pending so /run-style invocation is a clean state.
  await admin
    .from("screenings")
    .update({
      status: "pending",
      checks_completed: 0,
      checks_total: 0,
      completed_at: null,
    })
    .eq("id", id);

  // Defense-in-depth individual guard (mirrors /run).
  let persons = (screening.persons || []) as Person[];
  if (screening.entity_type === "individual" && persons.every(p => !p.name?.trim())) {
    persons = [{ name: screening.entity_name, role: "", aliases: [] }];
  }

  const job = {
    screeningId: id,
    entityName: screening.entity_name,
    entityType: screening.entity_type as "company" | "individual",
    jurisdiction: screening.jurisdiction,
    registrationNumber: screening.registration_number,
    persons,
  };

  // Fire and forget — same pattern as /run.
  runScreening(job).catch(err => {
    console.error("Background screening (retry) failed:", err);
  });

  return NextResponse.json(
    { message: "Screening retry started", totalChecks: calculateTotalChecks(job) },
    { status: 202 }
  );
}
