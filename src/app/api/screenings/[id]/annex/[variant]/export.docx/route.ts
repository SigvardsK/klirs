/**
 * Annex DOCX export — converts the same HTML the preview/PDF routes render
 * into a .docx file so advocates can edit fields that Klirs couldn't
 * pre-fill cleanly (e.g. the LV/EE/LT/EU-only jurisdiction dropdown).
 *
 * Uses html-to-docx (pure JS, no native deps) — preserves tables, inline
 * styling, checkbox symbols (☐ ☒), Latvian UTF-8, and basic colors.
 *
 * Implementation note: html-to-docx v1.8.0 crashes on CSS percentage
 * widths in table cells (`tableCellWidth` helper chokes on `%` values,
 * throws `Invalid XML name: @w`). We strip `width: N%` from the HTML
 * before conversion. PDF path is untouched — percent widths are needed
 * there for the risk table layout.
 */

import { NextResponse } from "next/server";
import HTMLtoDOCX from "html-to-docx";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { deriveRisk } from "@/lib/risk-score";
import type { Screening, ScreeningCheck } from "@/lib/types";
import { ANNEX_META, isAnnexVariant } from "@/lib/annex/variants";
import { slugify } from "@/lib/annex/shared";
import {
  buildAnnexP2Html,
  buildAnnexP31Html,
  buildAnnexP32Html,
  type AnnexBuildContext,
} from "@/lib/annex/templates";

function sanitizeHtmlForDocx(html: string): string {
  // html-to-docx v1.8.0 bug: percent widths on table cells crash the
  // xmlbuilder2 inner layer. Strip them. Other styling (colors, fonts,
  // backgrounds, alignment) survives.
  return html.replace(/width:\s*\d+%;?/g, "");
}

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
  const htmlRaw =
    variant === "p2" ? buildAnnexP2Html(ctx)
    : variant === "p3_1" ? buildAnnexP31Html(ctx)
    : buildAnnexP32Html(ctx);
  const html = sanitizeHtmlForDocx(htmlRaw);

  const meta = ANNEX_META[variant];

  try {
    const buf = await HTMLtoDOCX(html, undefined, {
      orientation: "portrait",
      margins: { top: 720, right: 720, bottom: 720, left: 720 },
      title: `${meta.code} — ${screening.entity_name}`,
    });

    const filename = `annex-${variant.replace("_", "-")}-${slugify(screening.entity_name)}-${id.slice(0, 8)}.docx`;
    // html-to-docx's declared return type is ArrayBuffer | Blob. In Node it returns
    // a Buffer (subclass of Uint8Array). Blob would also be an acceptable BodyInit,
    // ArrayBuffer is not directly. Coerce via Uint8Array so NextResponse is happy.
    const body = Buffer.isBuffer(buf)
      ? new Uint8Array(buf)
      : buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : (buf as Blob);
    return new NextResponse(body as BodyInit, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, max-age=0, no-store",
      },
    });
  } catch (err) {
    console.error(`Annex DOCX export failed (${variant}):`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "DOCX generation failed" },
      { status: 500 }
    );
  }
}
