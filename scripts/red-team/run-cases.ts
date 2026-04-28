/**
 * Red-team orchestrator — runs each case through the full lawyer workflow
 * (form submit → screening poll → results review → annex generation) and
 * writes a markdown report to docs/red-team-<date>.md.
 *
 * Usage:
 *   BASE_URL=https://your-deployment.example.com npm run red-team:run
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "playwright";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { CASES, type RedTeamCase } from "./cases";
import {
  screenshot,
  waitForCompletion,
  writeJson,
  type Timings,
  type CheckSummary,
} from "./capture";
import {
  writeReport,
  type Finding,
  type CaseRun,
  type Priority,
} from "./report";

chromium.use(StealthPlugin());

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const AUTH_PATH = resolve(HERE, "auth.json");
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const REVIEWER_NAME = process.env.RED_TEAM_REVIEWER || "Test Reviewer";

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const RUNS_DIR = resolve(HERE, "runs", TS);
const REPORT_PATH = resolve(REPO, "docs", `red-team-${TS.slice(0, 10)}.md`);

let findingCounter = 0;
const findings: Finding[] = [];
function addFinding(priority: Priority, area: string, title: string, detail: string, caseId: string, recommendation?: string) {
  findingCounter++;
  findings.push({ id: `F${findingCounter}`, priority, area, title, detail, caseId, recommendation });
}

async function ensureAuth(): Promise<void> {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(`Missing auth state at ${AUTH_PATH}. Run: npm run red-team:auth first.`);
  }
}

async function fillForm(page: Page, c: RedTeamCase): Promise<void> {
  await page.goto(`${BASE_URL}/screenings/new`);
  await page.waitForLoadState("networkidle");

  // Entity type — click the "Individual" or "Company" button.
  const typeLabel = c.entityType === "individual" ? "Individual" : "Company";
  await page.getByRole("button", { name: typeLabel, exact: true }).first().click();
  await page.waitForTimeout(200); // let conditional UI render

  // Entity name — the only required text input on the form.
  await page.locator('input[required]').first().fill(c.entityName);

  // Jurisdiction — native <select>.
  await page.locator('select').first().selectOption(c.jurisdiction);

  if (c.entityType === "company") {
    if (c.registrationNumber) {
      // Reg No input has placeholder starting with "e.g., 40003" — unique.
      await page.locator('input[placeholder^="e.g., 4000"]').first().fill(c.registrationNumber);
    }
    if (c.persons && c.persons.length > 0) {
      for (let i = 0; i < c.persons.length; i++) {
        const p = c.persons[i];
        if (i > 0) {
          await page.getByRole("button", { name: /Add Person/i }).first().click();
          await page.waitForTimeout(150);
        }
        // Company-person full-name placeholder is exactly "Full name"
        const nameInputs = page.locator('input[placeholder="Full name"]');
        await nameInputs.nth(i).fill(p.name);
        // Role placeholder starts with "Role"
        const roleInputs = page.locator('input[placeholder^="Role"]');
        if (await roleInputs.count() > i) {
          await roleInputs.nth(i).fill(p.role);
        }
      }
    }
  }

  if (c.entityType === "individual" && c.individualAliases && c.individualAliases.length > 0) {
    for (let i = 0; i < c.individualAliases.length; i++) {
      await page.getByRole("button", { name: /Add alias/i }).first().click();
      await page.waitForTimeout(150);
      // Alias placeholders: i===0 → "e.g., John Smith", i>0 → "Alternative spelling"
      // Both overlap with the main entity-name placeholder. Instead, use the
      // alias-input count: the i-th alias input is the last one added, and
      // it lives inside a list alongside other alias inputs. We target by
      // position among inputs that are NOT required (i.e. not the entity name).
      const aliasInputs = page.locator('input[placeholder="Alternative spelling"], input[placeholder="e.g., John Smith"]:not([required])');
      // After each "Add alias" click, the new input is the last in DOM order.
      const count = await aliasInputs.count();
      await aliasInputs.nth(count - 1).fill(c.individualAliases[i]);
    }
  }
}

async function submitForm(page: Page): Promise<string> {
  // Wait for navigation to /screenings/<uuid>.
  const navPromise = page.waitForURL(/\/screenings\/[0-9a-f]{8}-/, { timeout: 30_000 });
  await page.getByRole("button", { name: /Start Screening|Submit|Run Screening/i }).first().click();
  await navPromise;
  const url = page.url();
  const m = url.match(/\/screenings\/([0-9a-f-]{36})/);
  if (!m) throw new Error(`Submission did not land on screening detail: ${url}`);
  return m[1];
}

function evaluateCase(c: RedTeamCase, checks: CheckSummary[]): { pass: boolean; reasons: string[]; level: string } {
  const reasons: string[] = [];
  let pass = true;

  // Sanctions hit expectations.
  if (c.expectedSanctionsHit) {
    for (const dbName of c.expectedSanctionsHit) {
      const hit = checks.find(ch => ch.category === "sanctions" && ch.database_name === dbName && ch.status === "hit");
      if (!hit) {
        pass = false;
        reasons.push(`✗ Expected sanctions HIT on "${dbName}" not found.`);
      } else {
        reasons.push(`✓ Sanctions HIT on "${dbName}".`);
      }
    }
  }

  if (c.expectedNoSanctionsHit) {
    const sanctionsHits = checks.filter(ch => ch.category === "sanctions" && ch.status === "hit");
    if (sanctionsHits.length > 0) {
      pass = false;
      reasons.push(`✗ Unexpected sanctions HIT(s): ${sanctionsHits.map(c => c.database_name).join(", ")}.`);
    } else {
      reasons.push(`✓ No sanctions hits (as expected).`);
    }
  }

  // We don't derive risk level here (server does). We'll verify via the
  // analysis tab HTML instead — cheap substring check for "REJECT", "HIGH"
  // etc. Keeping this function simple.
  return { pass, reasons, level: "(see UI)" };
}

async function probeAnnexes(
  page: Page,
  screeningId: string,
  variants: string[]
): Promise<{ variant: string; previewStatus: number; pdfStatus: number; pdfBytes: number }[]> {
  const results = [];
  for (const v of variants) {
    const previewUrl = `${BASE_URL}/api/screenings/${screeningId}/annex/${v}/preview?reviewer=${encodeURIComponent(REVIEWER_NAME)}`;
    const pdfUrl = `${BASE_URL}/api/screenings/${screeningId}/annex/${v}/export.pdf?reviewer=${encodeURIComponent(REVIEWER_NAME)}`;
    const [prev, pdf] = await Promise.all([
      page.request.get(previewUrl),
      page.request.get(pdfUrl),
    ]);
    const previewStatus = prev.status();
    const pdfStatus = pdf.status();
    const pdfBytes = pdfStatus === 200 ? (await pdf.body()).length : 0;
    results.push({ variant: v, previewStatus, pdfStatus, pdfBytes });
  }
  return results;
}

async function runCase(browser: Browser, c: RedTeamCase): Promise<CaseRun> {
  const caseDir = resolve(RUNS_DIR, c.id);
  mkdirSync(caseDir, { recursive: true });

  const context = await browser.newContext({ storageState: AUTH_PATH, viewport: { width: 1400, height: 900 } });
  const page = await context.newPage() as Page;
  const timings: Timings = {};
  const screenshots: string[] = [];

  try {
    // 1. Navigate to form + fill.
    timings.t_open_form = Date.now();
    await fillForm(page, c);
    timings.t_form_filled = Date.now();
    screenshots.push(await screenshot(page, caseDir, "1-form-filled"));

    // 2. Submit.
    timings.t_submit = Date.now();
    const screeningId = await submitForm(page);
    timings.t_landed_on_results = Date.now();
    const resultUrl = page.url();
    screenshots.push(await screenshot(page, caseDir, "2-landed-on-results"));

    // 3. Poll via HTTP until completed.
    const checks = await waitForCompletion(page, screeningId, BASE_URL, timings);
    writeJson(resolve(caseDir, "checks.json"), checks);

    // 4. Reload, capture final state.
    await page.reload();
    await page.waitForLoadState("networkidle");
    screenshots.push(await screenshot(page, caseDir, "3-results-final"));

    // 5. Click Analysis tab + screenshot.
    await page.getByRole("tab", { name: /Analysis/i }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    screenshots.push(await screenshot(page, caseDir, "4-analysis-tab"));

    // 6. Evaluate expectations.
    const { pass, reasons } = evaluateCase(c, checks);

    // 7. Probe annexes (HTTP + byte size sanity).
    const annexHttp = await probeAnnexes(page, screeningId, c.expectedAnnexes);
    for (const a of annexHttp) {
      if (a.previewStatus !== 200) {
        addFinding("BLOCKER", `Annex ${a.variant}`, "Preview endpoint failed",
          `Preview returned HTTP ${a.previewStatus} for screening ${screeningId}.`, c.id,
          "Check server logs for exception in annex preview route.");
      }
      if (a.pdfStatus !== 200) {
        addFinding("BLOCKER", `Annex ${a.variant}`, "PDF export failed",
          `PDF returned HTTP ${a.pdfStatus} for screening ${screeningId}.`, c.id,
          "Check Playwright browser launch on server; datacenter IP may trigger extra delay.");
      }
      if (a.pdfStatus === 200 && a.pdfBytes < 20_000) {
        addFinding("IMPORTANT", `Annex ${a.variant}`, "PDF suspiciously small",
          `PDF is only ${a.pdfBytes} bytes — may indicate empty/broken render.`, c.id,
          "Open the PDF manually; compare to a known-good case.");
      }
    }

    // 8. If case failed expectations, record findings.
    if (!pass) {
      const failReasons = reasons.filter(r => r.startsWith("✗"));
      for (const fr of failReasons) {
        addFinding("BLOCKER", "Engine", `Screening expectation failed (${c.id})`, fr.replace(/^✗ /, ""), c.id,
          "Inspect screenshots + checks.json in run artefacts; fix before sending.");
      }
    }

    return {
      caseId: c.id,
      title: c.title,
      screeningId,
      submitUrl: `${BASE_URL}/screenings/new`,
      resultUrl,
      pass,
      verdictReasons: reasons,
      timings,
      checks,
      annexHttp,
      screenshots,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addFinding("BLOCKER", "Harness", `Case ${c.id} crashed`, msg, c.id, "Re-run; inspect run-cases.ts.");
    try { screenshots.push(await screenshot(page, caseDir, "error-state")); } catch {}
    return {
      caseId: c.id,
      title: c.title,
      screeningId: null,
      submitUrl: null,
      resultUrl: null,
      pass: false,
      verdictReasons: [`Crash: ${msg}`],
      timings,
      checks: [],
      annexHttp: [],
      screenshots,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  await ensureAuth();
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(resolve(REPO, "docs"), { recursive: true });

  const caseFilter = (process.env.CASE || "").split(",").map(s => s.trim()).filter(Boolean);
  const cases = caseFilter.length
    ? CASES.filter(c => caseFilter.includes(c.id))
    : CASES;
  if (!cases.length) {
    throw new Error(`No cases match CASE="${process.env.CASE}". Available: ${CASES.map(c => c.id).join(", ")}`);
  }

  console.log(`Red-team run → ${RUNS_DIR}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Cases: ${cases.map(c => c.id).join(", ")}`);

  let commit = "unknown";
  try {
    commit = execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim();
  } catch {}

  const browser = await chromium.launch({ headless: true });

  const runs: CaseRun[] = [];
  for (const c of cases) {
    console.log(`--- ${c.title} ---`);
    const r = await runCase(browser, c);
    runs.push(r);
    console.log(`  ${r.pass ? "✓ PASS" : "✗ FAIL"}  screening=${r.screeningId}  checks=${r.checks.length}`);
  }

  await browser.close();

  writeReport(REPORT_PATH, {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    authUser: process.env.RED_TEAM_AUTH_USER || "(superuser session)",
    commit,
    runs,
    findings,
  });

  console.log(`\n✓ Report written: ${REPORT_PATH}`);
  const blockers = findings.filter(f => f.priority === "BLOCKER").length;
  const passCount = runs.filter(r => r.pass).length;
  if (blockers === 0 && passCount === runs.length) {
    console.log(`✓ SAFE to send (${passCount}/${runs.length} passed, 0 BLOCKERs).`);
    process.exit(0);
  } else {
    console.log(`✗ NOT SAFE: ${blockers} BLOCKER(s), ${passCount}/${runs.length} passed.`);
    process.exit(1);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
