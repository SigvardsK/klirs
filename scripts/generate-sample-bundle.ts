/**
 * Generate sample evidence bundle artefacts for outreach replies (A3 — Sprint 2).
 *
 * Produces fully synthetic data (no real client PII), renders the Latvian Bar
 * Association annexes P2 + P3.1 as both PDF (via Playwright) and DOCX (via
 * html-to-docx). The full evidence bundle for prospect inspection is the live
 * /demo page at https://klirs.eu/demo — this script only ships the annex
 * artefacts an advocate would file alongside the bundle.
 *
 * Output directory: docs/sprint-2/sample-bundle/ (gitignored via /docs/sprint-2/).
 *
 * Usage: npx tsx scripts/generate-sample-bundle.ts
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import HTMLtoDOCX from "html-to-docx";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveRisk } from "../src/lib/risk-score";
import { SEARCHABLE_DATABASES } from "../src/lib/db-configs";
import {
  buildAnnexP2Html,
  buildAnnexP31Html,
  type AnnexBuildContext,
} from "../src/lib/annex/templates";
import { ANNEX_META } from "../src/lib/annex/variants";
import type { Screening, ScreeningCheck } from "../src/lib/types";

chromium.use(StealthPlugin());

const OUT_DIR = join(__dirname, "..", "docs", "sprint-2", "sample-bundle");

const SUBJECT_NAME = "Jānis Bērziņš";
const SUBJECT_DOB = "1985-06-12";
const SUBJECT_PERSCODE = "120685-XXXXX"; // synthetic — last 5 redacted
const BASE_TIME = new Date("2026-05-01T09:00:00Z");

function ts(offsetMin: number): string {
  return new Date(BASE_TIME.getTime() + offsetMin * 60_000).toISOString();
}

function buildSyntheticChecks(): ScreeningCheck[] {
  const checks: ScreeningCheck[] = [];
  let idx = 0;
  let off = 0;

  // Sanctions + PEP databases — every searchable database returns clear.
  for (const db of SEARCHABLE_DATABASES) {
    if (db.companyOnly) continue; // individual subject
    checks.push({
      id: `sample-${idx++}`,
      screening_id: "sample-bundle",
      database_name: db.name,
      category: db.category,
      search_term: SUBJECT_NAME,
      status: "clear",
      screenshot_path: null,
      details: null,
      source_url: null,
      checked_at: ts(off++),
    });
  }

  // Adverse media: 4 languages.
  for (const lang of ["LV", "EN", "ET", "RU"]) {
    checks.push({
      id: `sample-${idx++}`,
      screening_id: "sample-bundle",
      database_name: `Adverse Media (${lang})`,
      category: "adverse_media",
      search_term: `${SUBJECT_NAME} (${lang})`,
      status: "clear",
      screenshot_path: null,
      details: null,
      source_url: null,
      checked_at: ts(off++),
    });
  }

  return checks;
}

const SAMPLE_CHECKS = buildSyntheticChecks();

const SAMPLE_SCREENING: Screening = {
  id: "sample-bundle-jbe",
  created_by: "klirs-demo",
  entity_name: SUBJECT_NAME,
  entity_type: "individual",
  jurisdiction: "Latvia",
  registration_number: SUBJECT_PERSCODE,
  persons: [],
  status: "completed",
  checks_total: SAMPLE_CHECKS.length,
  checks_completed: SAMPLE_CHECKS.length,
  is_demo: true,
  created_at: ts(0),
  completed_at: ts(SAMPLE_CHECKS.length),
};

async function htmlToPdf(html: string, headerLabel: string): Promise<Buffer> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 1600 },
      locale: "lv-LV",
    });
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "12mm", bottom: "14mm", left: "12mm", right: "12mm" },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size: 8px; color: #64748b; width: 100%; text-align: center;">${headerLabel} — SAGATAVE · ${SUBJECT_NAME}</div>`,
      footerTemplate: `<div style="font-size: 8px; color: #64748b; width: 100%; text-align: center;">Lapa <span class="pageNumber"></span> / <span class="totalPages"></span> · Ģenerēts ${new Date().toISOString()}</div>`,
    });
    return pdf as Buffer;
  } finally {
    await browser.close();
  }
}

function sanitizeForDocx(html: string): string {
  return html.replace(/width:\s*\d+%;?/g, "");
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const risk = deriveRisk(SAMPLE_CHECKS);
  const ctx: AnnexBuildContext = {
    screening: SAMPLE_SCREENING,
    checks: SAMPLE_CHECKS,
    risk,
    reviewer: "Atbildīgā persona — paraksts un datums",
  };

  const variants: Array<{
    name: "p2" | "p3_1";
    html: string;
    label: string;
  }> = [
    { name: "p2", html: buildAnnexP2Html(ctx), label: ANNEX_META.p2.code },
    { name: "p3_1", html: buildAnnexP31Html(ctx), label: ANNEX_META.p3_1.code },
  ];

  for (const v of variants) {
    const slug = `klirs-sample-annex-${v.name.replace("_", "-")}-janis-berzins`;

    writeFileSync(join(OUT_DIR, `${slug}.html`), v.html);
    console.log(`[html] ${slug}.html (${v.html.length} bytes)`);

    const pdf = await htmlToPdf(v.html, v.label);
    writeFileSync(join(OUT_DIR, `${slug}.pdf`), pdf);
    console.log(`[pdf]  ${slug}.pdf  (${pdf.length} bytes)`);

    // html-to-docx returns Buffer | Blob | ArrayBuffer; assume Buffer in node.
    const docx = (await HTMLtoDOCX(sanitizeForDocx(v.html), undefined, {
      orientation: "portrait",
      pageSize: { width: "21cm", height: "29.7cm" },
      margins: { top: 720, right: 720, bottom: 720, left: 720 },
    })) as Buffer;
    writeFileSync(join(OUT_DIR, `${slug}.docx`), docx);
    console.log(`[docx] ${slug}.docx (${docx.length} bytes)`);
  }

  // Summary card written alongside the artefacts so anyone opening the
  // directory understands what they're looking at without context.
  const summary = `# Klirs — Sample Evidence Bundle Artefacts

Generated: ${new Date().toISOString()}
Subject: ${SUBJECT_NAME} (synthetic individual, Latvia jurisdiction)
Status: all-clear — no sanctions / PEP / adverse-media hits
Checks: ${SAMPLE_CHECKS.length} (sanctions + PEP + 4-language adverse media)
Risk verdict: ${risk.level} (score ${risk.score})

## Files

- klirs-sample-annex-p2-janis-berzins.{html,pdf,docx}    — Klienta risku novērtējuma veidlapa (P2)
- klirs-sample-annex-p3-1-janis-berzins.{html,pdf,docx}  — Sankciju izpētes veidlapa, fiziska persona (P3.1)

## What this is for

Outreach reply artefact. When a Bar Council / law firm / VASP recipient asks for "a sample bundle and pre-filled annexes" (per bar-council.md §3 commitment), attach the four artefacts above and link the live evidence bundle at https://klirs.eu/demo for browsing.

## What it isn't

Real client data. No PII. The personal code is synthetic (last 5 digits redacted). The all-clear status reflects a clean test subject only — the engine's BLOCKER classes (Cyrillic, abbreviated initial, hyphenated names) are exercised by the smoke suite (npm run smoke:sanctioned), not by this bundle.

## Regenerate

\`\`\`
npx tsx scripts/generate-sample-bundle.ts
\`\`\`

Idempotent. Overwrites existing files in this directory.
`;
  writeFileSync(join(OUT_DIR, "README.md"), summary);
  console.log(`[doc]  README.md`);

  console.log(`\nOK. Bundle at ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("Sample-bundle generation failed:", err);
  process.exit(1);
});
