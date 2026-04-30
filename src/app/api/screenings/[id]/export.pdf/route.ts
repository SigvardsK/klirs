/**
 * PDF export — generates a print-ready audit bundle for a completed screening.
 *
 * The browser UI has full evidence but no portable artefact a compliance officer
 * can file. This route builds a server-side HTML document containing entity
 * summary, category-weighted risk breakdown, every check row with its source URL,
 * and every evidence screenshot inline, then uses Playwright's `page.pdf()` to
 * render it as A4.
 *
 * Playwright is already a first-class dependency for the screening engine, so no
 * new deps. The HTML is built with a minimal inline stylesheet — no Tailwind, no
 * React SSR — so the PDF renderer has deterministic output regardless of the web
 * UI's styling stack.
 *
 * Auth model: owner-only. The caller must have a valid Supabase session and the
 * screening must be owned by them. The service-role key is used only once inside the
 * route to bypass RLS for the screenshot lookups (screenshots are in a public bucket
 * anyway, but we fetch metadata via admin client for consistency).
 */

import { NextResponse } from "next/server";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { createClient } from "@/lib/supabase/server";
import { createClient as createAdminClient } from "@supabase/supabase-js";
import { deriveRisk, type RiskLevel } from "@/lib/risk-score";
import type { Screening, ScreeningCheck } from "@/lib/types";
import { statusDisplayLabel } from "@/lib/types";

// VID PNP + VID VAD submit POST forms; captured URL is the service landing,
// not a deep-linked result. Render a caveat alongside the link in the PDF.
function isLandingOnlyUrl(databaseName: string): boolean {
  return databaseName.startsWith("VID ");
}

chromium.use(StealthPlugin());

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Ownership check via the user-scoped client (RLS enforces this too but fail fast).
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

  // Admin client to load checks without RLS overhead.
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
  const supabaseBaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const screenshotUrl = (path: string) =>
    `${supabaseBaseUrl}/storage/v1/object/public/evidence-screenshots/${path}`;

  const html = buildPrintHtml({ screening, checks, risk, screenshotUrl });

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 1600 },
      locale: "en-GB",
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "networkidle", timeout: 60_000 });
    // Extra settle — let lazy images resolve.
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "15mm", bottom: "18mm", left: "12mm", right: "12mm" },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size: 8px; color: #64748b; width: 100%; text-align: center;">Klirs — AML Screening Report — ${escapeHtml(screening.entity_name)}</div>`,
      footerTemplate: `<div style="font-size: 8px; color: #64748b; width: 100%; text-align: center;">Page <span class="pageNumber"></span> of <span class="totalPages"></span> · Generated <span>${new Date().toISOString()}</span></div>`,
    });

    const filename = `aml-screening-${slugify(screening.entity_name)}-${id.slice(0, 8)}.pdf`;
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, max-age=0, no-store",
      },
    });
  } catch (err) {
    console.error("PDF export failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "PDF generation failed" },
      { status: 500 }
    );
  } finally {
    if (browser) await browser.close();
  }
}

interface BuildInput {
  screening: Screening;
  checks: ScreeningCheck[];
  risk: ReturnType<typeof deriveRisk>;
  screenshotUrl: (path: string) => string;
}

function buildPrintHtml({ screening, checks, risk, screenshotUrl }: BuildInput): string {
  const persons = screening.persons || [];
  const checksByCategory = new Map<string, ScreeningCheck[]>();
  for (const c of checks) {
    if (!checksByCategory.has(c.category)) checksByCategory.set(c.category, []);
    checksByCategory.get(c.category)!.push(c);
  }

  const categoryLabel: Record<string, string> = {
    sanctions: "Sanctions",
    pep: "PEP / Officials",
    adverse_media: "Adverse Media",
    company_registry: "Company Registry",
    tax_risk: "Tax Risk",
  };

  const levelColor: Record<RiskLevel, string> = {
    "LOW": "#10b981",
    "LOW-MEDIUM": "#84cc16",
    "MEDIUM": "#f59e0b",
    "HIGH": "#f97316",
    "REJECT": "#ef4444",
  };

  const statusColor: Record<string, string> = {
    clear: "#10b981",
    hit: "#ef4444",
    uncertain: "#f59e0b",
    error: "#f97316",
    pending: "#64748b",
  };

  const completedAt = screening.completed_at
    ? new Date(screening.completed_at).toLocaleString("en-GB")
    : "—";
  const createdAt = new Date(screening.created_at).toLocaleString("en-GB");

  const breakdownRowsHtml = risk.breakdown.map(r => `
    <tr>
      <td>${escapeHtml(r.category)}</td>
      <td class="num">${r.hits || "—"}</td>
      <td class="num">${r.uncertains || "—"}</td>
      <td class="num b">+${r.contribution}</td>
    </tr>`).join("");

  const checksSectionHtml = [...checksByCategory.entries()]
    .map(([category, items]) => `
      <section class="cat">
        <h3>${escapeHtml(categoryLabel[category] || category)} <span class="count">${items.length} check${items.length === 1 ? "" : "s"}</span></h3>
        <table class="checks">
          <thead>
            <tr>
              <th>Database</th>
              <th>Search Term</th>
              <th>Status</th>
              <th>Source URL</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(c => `
              <tr>
                <td>${escapeHtml(c.database_name)}</td>
                <td>${escapeHtml(c.search_term)}</td>
                <td><span class="badge" style="background:${statusColor[c.status] || "#64748b"}20;color:${statusColor[c.status] || "#64748b"};border:1px solid ${statusColor[c.status] || "#64748b"}40;">${escapeHtml(statusDisplayLabel(c.status))}</span></td>
                <td class="url">${c.source_url ? `<a href="${escapeHtml(c.source_url)}">${escapeHtml(truncate(c.source_url, 80))}</a>${isLandingOnlyUrl(c.database_name) ? `<div class="url-caveat">search form — see screenshot</div>` : ""}` : "—"}</td>
                <td class="time">${c.checked_at ? new Date(c.checked_at).toLocaleTimeString("en-GB") : "—"}</td>
              </tr>
              ${c.details ? `<tr><td colspan="5" class="details">${escapeHtml(c.details)}</td></tr>` : ""}
            `).join("")}
          </tbody>
        </table>
      </section>
    `).join("");

  const screenshotsHtml = checks
    .filter(c => c.screenshot_path)
    .map((c, i) => `
      <figure class="shot${i === 0 ? " first" : ""}">
        <header class="shot-header">
          <div class="shot-title"><strong>${escapeHtml(c.database_name)}</strong> · search: ${escapeHtml(c.search_term)}</div>
          <div class="shot-meta">
            <span class="badge" style="background:${statusColor[c.status] || "#64748b"}20;color:${statusColor[c.status] || "#64748b"};border:1px solid ${statusColor[c.status] || "#64748b"}40;">${escapeHtml(statusDisplayLabel(c.status))}</span>
            ${c.source_url ? `<span class="url-caption">${escapeHtml(c.source_url)}${isLandingOnlyUrl(c.database_name) ? ` <em>(search form — screenshot is the result of record)</em>` : ""}</span>` : ""}
          </div>
        </header>
        <img src="${escapeHtml(screenshotUrl(c.screenshot_path!))}" alt="${escapeHtml(c.database_name)} – ${escapeHtml(c.search_term)}" />
      </figure>`).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Klirs — AML Screening Report — ${escapeHtml(screening.entity_name)}</title>
  <style>
    @page { size: A4; margin: 0; }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #0f172a;
      background: #ffffff;
      margin: 0;
      padding: 0;
      font-size: 10.5pt;
      line-height: 1.45;
    }
    h1 { font-size: 18pt; margin: 0 0 4pt 0; color: #0f172a; }
    h2 { font-size: 13pt; margin: 20pt 0 6pt 0; color: #0f172a; border-bottom: 1px solid #cbd5e1; padding-bottom: 4pt; }
    h3 { font-size: 11pt; margin: 14pt 0 6pt 0; color: #334155; }
    h3 .count { font-weight: 400; color: #64748b; font-size: 9.5pt; margin-left: 6pt; }
    p { margin: 0 0 6pt 0; }
    a { color: #0ea5e9; text-decoration: none; word-break: break-all; }
    .muted { color: #64748b; }
    .kv { display: flex; gap: 8pt; margin: 2pt 0; }
    .kv .k { color: #64748b; min-width: 80pt; }
    .kv .v { color: #0f172a; font-weight: 500; }
    header.cover { padding: 22pt 18pt 14pt 18pt; border-bottom: 2px solid #10b981; }
    header.cover .title { display: flex; align-items: baseline; justify-content: space-between; gap: 12pt; }
    header.cover .subtitle { color: #475569; font-size: 10pt; margin-top: 4pt; }
    main { padding: 14pt 18pt 22pt 18pt; }
    .risk-banner {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10pt 14pt; border-radius: 6pt; margin: 10pt 0;
      color: #ffffff;
      background: ${levelColor[risk.level]};
    }
    .risk-banner .lvl { font-size: 16pt; font-weight: 700; letter-spacing: 0.5pt; }
    .risk-banner .score { font-size: 22pt; font-weight: 700; }
    .risk-banner .score small { font-size: 10pt; font-weight: 400; opacity: 0.8; }
    table.breakdown, table.checks { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
    table.breakdown th, table.breakdown td,
    table.checks th, table.checks td {
      padding: 4pt 6pt; text-align: left; border-bottom: 1px solid #e2e8f0; vertical-align: top;
    }
    table.breakdown th, table.checks th { color: #64748b; font-weight: 600; background: #f8fafc; }
    table.breakdown td.num, table.breakdown th.num { text-align: right; }
    table.breakdown td.b { font-weight: 600; }
    table.checks td.url { max-width: 180pt; overflow-wrap: anywhere; color: #0ea5e9; font-size: 8.5pt; }
    table.checks td.url .url-caveat { color: #94a3b8; font-style: italic; font-size: 7.5pt; margin-top: 2pt; }
    table.checks td.time { color: #64748b; font-size: 8.5pt; white-space: nowrap; }
    table.checks tr td.details { color: #64748b; font-size: 8.5pt; font-style: italic; padding-left: 12pt; border-bottom: 1px solid #e2e8f0; }
    .badge { display: inline-block; padding: 1pt 6pt; font-size: 8.5pt; border-radius: 4pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3pt; }
    section.cat { page-break-inside: avoid; margin-top: 10pt; }
    /* One screenshot per page, full-width, contain-scaled so the entire captured
       page is visible and text is legible. First figure gets a page-break-before
       so the screenshots section starts fresh on its own page. */
    figure.shot { margin: 0 0 6pt 0; padding: 0; page-break-before: always; page-break-inside: avoid; }
    figure.shot .shot-header { padding: 4pt 6pt 6pt 6pt; border-bottom: 1px solid #e2e8f0; margin-bottom: 4pt; }
    figure.shot .shot-title { font-size: 10pt; color: #0f172a; }
    figure.shot .shot-meta { margin-top: 3pt; display: flex; align-items: center; gap: 8pt; flex-wrap: wrap; }
    figure.shot .shot-meta .url-caption em { color: #94a3b8; font-style: italic; }
    figure.shot img { width: 100%; display: block; max-height: 240mm; object-fit: contain; border: 1px solid #e2e8f0; border-radius: 4pt; }
    .url-caption { color: #0ea5e9; word-break: break-all; font-size: 8pt; }
    .assessment { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6pt; padding: 10pt 12pt; margin: 6pt 0; font-size: 10pt; }
    .assessment p { margin: 0 0 4pt 0; }
    .footer-note { margin-top: 20pt; padding-top: 10pt; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 8.5pt; }
  </style>
</head>
<body>
  <header class="cover">
    <div class="title">
      <div>
        <h1>Klirs — AML Screening Report</h1>
        <div class="subtitle">${escapeHtml(screening.entity_name)} · ${escapeHtml(screening.entity_type === "company" ? "Company" : "Individual")} · ${escapeHtml(screening.jurisdiction)}</div>
      </div>
      <div style="text-align:right;">
        <div class="muted">Screening ID</div>
        <div style="font-family:monospace;font-size:9pt;">${escapeHtml(screening.id)}</div>
      </div>
    </div>
  </header>

  <main>
    <section>
      <h2>Summary</h2>
      <div class="risk-banner">
        <div>
          <div style="font-size:9pt;text-transform:uppercase;letter-spacing:0.5pt;opacity:0.9;">Risk Classification</div>
          <div class="lvl">${escapeHtml(risk.level)}${risk.incomplete ? " (INCOMPLETE)" : ""}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:9pt;text-transform:uppercase;letter-spacing:0.5pt;opacity:0.9;">Score</div>
          <div class="score">${risk.score} <small>/ 2,500+</small></div>
        </div>
      </div>

      <div class="kv"><span class="k">Entity</span> <span class="v">${escapeHtml(screening.entity_name)}</span></div>
      <div class="kv"><span class="k">Type</span> <span class="v">${escapeHtml(screening.entity_type === "company" ? "Company" : "Individual")}</span></div>
      <div class="kv"><span class="k">Jurisdiction</span> <span class="v">${escapeHtml(screening.jurisdiction)}</span></div>
      ${screening.registration_number ? `<div class="kv"><span class="k">Reg. Number</span> <span class="v">${escapeHtml(screening.registration_number)}</span></div>` : ""}
      <div class="kv"><span class="k">Submitted</span> <span class="v">${escapeHtml(createdAt)}</span></div>
      <div class="kv"><span class="k">Completed</span> <span class="v">${escapeHtml(completedAt)}</span></div>
      <div class="kv"><span class="k">Checks</span> <span class="v">${checks.length} total · ${checks.filter(c => c.status === "clear").length} clear · ${checks.filter(c => c.status === "hit").length} hit · ${checks.filter(c => c.status === "uncertain").length} to review · ${checks.filter(c => c.status === "error").length} error</span></div>
      ${persons.length > 0 ? `<div class="kv"><span class="k">Persons</span> <span class="v">${escapeHtml(persons.map(p => p.aliases && p.aliases.length ? `${p.name} (aliases: ${p.aliases.join(", ")})` : p.name).join(" · "))}</span></div>` : ""}
    </section>

    ${risk.breakdown.length > 0 ? `
    <section>
      <h2>Risk Score Breakdown</h2>
      <p class="muted" style="font-size:9pt;">Category-weighted derivation. A sanctions hit escalates directly to the highest classification; results flagged for review contribute per category with diminishing weight per additional row.</p>
      <table class="breakdown">
        <thead>
          <tr>
            <th>Category</th>
            <th class="num">Hits</th>
            <th class="num">Review</th>
            <th class="num">Contribution</th>
          </tr>
        </thead>
        <tbody>
          ${breakdownRowsHtml}
          <tr>
            <td class="b">Total</td>
            <td></td>
            <td></td>
            <td class="num b" style="color:${levelColor[risk.level]};">${risk.score}</td>
          </tr>
        </tbody>
      </table>
    </section>` : ""}

    <section>
      <h2>Risk Assessment</h2>
      <div class="assessment">
        ${riskAssessmentCopy(risk.level, risk.incomplete, screening, checks)}
      </div>
    </section>

    <section>
      <h2>Checks</h2>
      ${checksSectionHtml || `<p class="muted">No checks recorded.</p>`}
    </section>

    <section>
      <h2>Evidence Screenshots</h2>
      <p class="muted" style="font-size:9pt;">Each screenshot was captured by an automated headless browser with a timestamped evidence header showing database name, search term, and capture timestamp. One screenshot per page, at full size — the source URL, status, and search term appear above each image.</p>
      ${screenshotsHtml || `<p class="muted">No evidence screenshots captured.</p>`}
    </section>

    <section>
      <h2>Sources</h2>
      <p style="font-size:9.5pt;">Sanctions: OFAC SDN (US Treasury); UK Sanctions List (GOV.UK / FCDO); the Latvian FID consolidated sanctions list (Latvia, EU, UN, US, UK, AU — aggregated and served by Firmas.lv, with the source list published by the Financial Intelligence Unit of Latvia).</p>
      <p style="font-size:9.5pt;">PEP: VID PNP (tax debtors) and VID VAD (officials&apos; declarations) — Latvian taxpayers only. Both VID services submit POST forms and render results in place, so their source URLs link to the live service rather than a reproducible result; the evidence of record is the screenshot.</p>
      <p style="font-size:9.5pt;">Adverse media: DuckDuckGo across LV / EN / ET / RU.</p>
      <p style="font-size:9.5pt;">Company registry: Uzņēmumu reģistrs (Latvia) for company entities only.</p>
    </section>

    <div class="footer-note">
      <strong>Audit chain-of-custody:</strong> Generated ${new Date().toISOString()} from screening record ${escapeHtml(screening.id)}. Every check row carries a source URL and a timestamped screenshot. Screenshots are hosted in a private Supabase storage bucket with row-level security; only the authenticated owner of this screening can generate this report.
    </div>
  </main>
</body>
</html>`;
}

function riskAssessmentCopy(
  level: RiskLevel,
  incomplete: boolean,
  screening: Screening,
  checks: ScreeningCheck[]
): string {
  const entity = escapeHtml(screening.entity_name);
  const hit = checks.filter(c => c.status === "hit").length;
  const unc = checks.filter(c => c.status === "uncertain").length;
  const err = checks.filter(c => c.status === "error").length;
  const parts: string[] = [];

  if (level === "REJECT") {
    parts.push(`<p><strong>A sanctions match was confirmed against ${entity}</strong> on one or more sources. Do not onboard or process this entity, and report to the compliance officer and/or the FID as required by law.</p>`);
    parts.push(`<p>Recommended: block the relationship and document the evidence (screenshots and source URLs) in the compliance file.</p>`);
  } else if (level === "HIGH") {
    parts.push(`<p><strong>A sanctions source returned a result that could not be confirmed as a no-match</strong> — the result page does not match the expected clean-result layout. Treat ${entity} as high risk until a human reviews the captured evidence.</p>`);
    parts.push(`<p>Recommended: inspect each sanctions check flagged for investigation. If all are confirmed clean on manual review, re-run the screening with a clarified alias; otherwise escalate to enhanced due diligence.</p>`);
  } else if (level === "MEDIUM") {
    parts.push(`<p><strong>${unc} check(s) need review</strong> — the result page was not recognisable as a confirmed no-match. This does not mean a match was found; it means a human must verify each flagged screenshot.</p>`);
    parts.push(`<p>Recommended: inspect each flagged result's screenshot. If all are confirmed clean, the risk drops to low. If any show a match, escalate to enhanced due diligence.</p>`);
  } else if (level === "LOW-MEDIUM") {
    parts.push(`<p>Sanctions and PEP checks returned their confirmed no-match indicators, but the adverse-media search surfaced results that could not be confirmed as clean.</p>`);
    parts.push(`<p>Recommended: proceed with standard due diligence while documenting the adverse-media review in the compliance file.</p>`);
  } else {
    parts.push(`<p>Every sanctions and PEP database returned its confirmed no-match indicator for ${entity}${screening.persons?.length ? ` and ${screening.persons.length} associated person(s)` : ""}.</p>`);
    parts.push(`<p>Recommended: proceed with standard due diligence per your internal AML policy. Retain the evidence screenshots for audit.</p>`);
  }

  if (incomplete) {
    parts.push(`<p style="color:#f97316;"><strong>Note:</strong> ${err} database check(s) returned errors (typically bot-detection or network timeouts). Re-run the screening or verify the affected sources manually — the risk level above is based only on checks that completed.</p>`);
  }

  // Stats line
  parts.push(`<p class="muted" style="font-size:9pt;">Screening ran ${checks.length} database check(s): ${checks.filter(c => c.status === "clear").length} confirmed no-match · ${hit} hit · ${unc} to review · ${err} error.</p>`);

  return parts.join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(s: string, maxLen: number): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}
