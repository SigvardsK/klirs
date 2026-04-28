/**
 * Annex preview route — returns HTML for an in-browser iframe preview.
 *
 * Same HTML that the PDF export uses (so WYSIWYG is deterministic); this
 * route is the lawyer's way to see the generated form before committing
 * to download. Ownership-checked via Supabase session.
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { deriveRisk } from "@/lib/risk-score";
import type { Screening, ScreeningCheck } from "@/lib/types";
import { isAnnexVariant } from "@/lib/annex/variants";
import {
  buildAnnexP2Html,
  buildAnnexP31Html,
  buildAnnexP32Html,
  type AnnexBuildContext,
} from "@/lib/annex/templates";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; variant: string }> }
) {
  const { id, variant } = await params;

  if (!isAnnexVariant(variant)) {
    return NextResponse.json(
      { error: "Unknown annex variant" },
      { status: 400 }
    );
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: screeningRow } = await supabase
    .from("screenings")
    .select("*")
    .eq("id", id)
    .eq("created_by", user.id)
    .single();

  if (!screeningRow) {
    return NextResponse.json({ error: "Screening not found" }, { status: 404 });
  }

  const screening = screeningRow as Screening;

  const admin = createAdminClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
  const { data: checksRows } = await admin
    .from("screening_checks")
    .select("*")
    .eq("screening_id", id)
    .order("checked_at", { ascending: true });

  const checks = (checksRows || []) as ScreeningCheck[];
  const risk = deriveRisk(checks);

  const url = new URL(request.url);
  const reviewer = (url.searchParams.get("reviewer") || "").trim();

  const ctx: AnnexBuildContext = { screening, checks, risk, reviewer };
  const html =
    variant === "p2" ? buildAnnexP2Html(ctx)
    : variant === "p3_1" ? buildAnnexP31Html(ctx)
    : buildAnnexP32Html(ctx);

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, max-age=0, no-store",
    },
  });
}
