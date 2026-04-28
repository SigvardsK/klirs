/**
 * Annex PDF export route — Playwright renders the same HTML the preview
 * route returns, then sends as application/pdf with Content-Disposition
 * attachment. Pattern mirrors `src/app/api/screenings/[id]/export.pdf/route.ts`
 * (the full audit-bundle PDF). No new Playwright dependency.
 */

import { NextResponse } from "next/server";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
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

chromium.use(StealthPlugin());

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

  const meta = ANNEX_META[variant];

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1600 },
      locale: "lv-LV",
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "14mm", left: "12mm", right: "12mm" },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size: 8px; color: #64748b; width: 100%; text-align: center;">${meta.code} — SAGATAVE · ${escapeAttr(screening.entity_name)}</div>`,
      footerTemplate: `<div style="font-size: 8px; color: #64748b; width: 100%; text-align: center;">Page <span class="pageNumber"></span> / <span class="totalPages"></span> · Ģenerēts ${new Date().toISOString()}</div>`,
    });

    const filename = `annex-${variant.replace("_", "-")}-${slugify(screening.entity_name)}-${id.slice(0, 8)}.pdf`;
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, max-age=0, no-store",
      },
    });
  } catch (err) {
    console.error(`Annex PDF export failed (${variant}):`, err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "PDF generation failed" },
      { status: 500 }
    );
  } finally {
    if (browser) await browser.close();
  }
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
