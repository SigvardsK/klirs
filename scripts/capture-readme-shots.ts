/**
 * One-off README screenshot capture.
 *
 * Reuses scripts/red-team/auth.json for Supabase session. Captures the four
 * UI shots referenced from README.md into public/screenshots/.
 *
 * Usage:
 *   BASE_URL=https://klirs.eu npx tsx scripts/capture-readme-shots.ts
 *
 * If auth fails: run `BASE_URL=... npm run red-team:auth` first.
 *
 * The PDF page render (05-pdf-page.png) is produced separately via pdftoppm —
 * see scripts/render-pdf-hero.sh.
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";

chromium.use(StealthPlugin());

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const AUTH_PATH = resolve(REPO, "scripts/red-team/auth.json");
const OUT_DIR = resolve(REPO, "public/screenshots");
const BASE_URL = process.env.BASE_URL || "https://klirs.eu";
const HERO_NAME = process.env.HERO_NAME || "Jānis Bērziņš";

if (!existsSync(AUTH_PATH)) {
  console.error(`Auth state not found: ${AUTH_PATH}`);
  console.error(`Run: BASE_URL=${BASE_URL} npm run red-team:auth`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

/**
 * Scrub identifying / Railway-freemium-only DOM before each screenshot.
 * - Replaces top-right user display name with a generic placeholder
 * - Removes the "DEMO — Sample Analysis" banner (Railway-only; OSS self-host
 *   has no payment gating, so the banner is misleading for README purposes)
 */
async function scrub(page: import("playwright").Page) {
  await page.evaluate(() => {
    // Username in top-right header — replace text inside any element whose
    // textContent matches the user's account display name pattern.
    document.querySelectorAll("header *, nav *").forEach((el) => {
      if (el.children.length === 0 && el.textContent && /^Sigvards\s/.test(el.textContent.trim())) {
        el.textContent = "compliance@example.com";
      }
    });
    // Demo / sample-analysis banners (Railway freemium UI only)
    document.querySelectorAll("div, section, aside").forEach((el) => {
      const t = (el.textContent || "").trim();
      if (
        /^DEMO\b/i.test(t) ||
        /Sample Analysis/i.test(t.split("\n")[0] || "") ||
        /Contact us for a full risk evaluation/i.test(t)
      ) {
        // Only nuke if it's a small banner-sized element, not a parent
        if (el.getBoundingClientRect().height < 200 && el.children.length < 5) {
          el.remove();
        }
      }
    });
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_PATH,
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  // Sanity probe — bounce off /dashboard to confirm auth is alive.
  console.log(`[probe] ${BASE_URL}/dashboard`);
  const probe = await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle", timeout: 30_000 });
  if (!probe || probe.status() >= 400 || page.url().includes("/login")) {
    console.error(`Auth probe failed (status=${probe?.status()}, url=${page.url()})`);
    console.error(`Re-auth: BASE_URL=${BASE_URL} npm run red-team:auth`);
    await browser.close();
    process.exit(2);
  }
  console.log(`[probe] OK — landed on ${page.url()}`);

  // ── 01: New screening form with VariantPreview ─────────────────────────
  console.log(`[01] /screenings/new — form + variant preview`);
  await page.goto(`${BASE_URL}/screenings/new`, { waitUntil: "networkidle" });
  // Switch to Individual mode (cleaner demo than Company + BO list)
  const individualBtn = page.locator('button:has-text("Individual")').first();
  if (await individualBtn.count()) {
    await individualBtn.click();
    await page.waitForTimeout(300);
  }
  // Individual mode shows a "Full Name" input with placeholder "e.g., John Smith".
  const nameInput = page.locator('input[placeholder*="John Smith" i], input[placeholder*="full name" i]').first();
  if (await nameInput.count()) {
    await nameInput.click();
    await nameInput.fill(HERO_NAME);
    // React controlled inputs sometimes ignore Playwright's fill — dispatch input event
    await nameInput.evaluate((el: HTMLInputElement, val: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, HERO_NAME);
    await page.waitForTimeout(1200); // let VariantPreview render
  } else {
    console.warn(`[01] full-name input not found — capturing empty form`);
  }
  await scrub(page);
  await page.screenshot({ path: resolve(OUT_DIR, "01-form.png"), fullPage: false });

  // ── Find a completed screening to drive 02/03/04 ───────────────────────
  console.log(`[lookup] finding ${HERO_NAME} on /dashboard`);
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
  // Extract /screenings/[id] href from any anchor whose subtree contains HERO_NAME
  const heroHref = await page.evaluate((name) => {
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/screenings/"]'));
    const match = anchors.find(a =>
      a.textContent?.includes(name) && /\/screenings\/[0-9a-f-]{16,}/.test(a.getAttribute("href") || "")
    );
    return match?.getAttribute("href") || null;
  }, HERO_NAME);
  if (!heroHref) {
    console.error(`[lookup] no /screenings/[id] anchor containing "${HERO_NAME}"`);
    console.error(`Set HERO_NAME=<exact entity_name as shown on dashboard>`);
    await browser.close();
    process.exit(3);
  }
  console.log(`[lookup] navigating to ${heroHref}`);
  await page.goto(`${BASE_URL}${heroHref}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500); // let tabs hydrate
  console.log(`[lookup] on ${page.url()}`);

  // ── 04: Analysis tab (HERO) ────────────────────────────────────────────
  console.log(`[04] analysis tab (hero)`);
  const analysisTab = page.locator('button:has-text("Analysis"), [role="tab"]:has-text("Analysis"), a:has-text("Analysis")').first();
  if (await analysisTab.count()) {
    await analysisTab.click();
    await page.waitForTimeout(1000);
  }
  await scrub(page);
  await page.screenshot({ path: resolve(OUT_DIR, "04-analysis.png"), fullPage: false });

  // ── 03: Screenshots tab (evidence) ─────────────────────────────────────
  console.log(`[03] screenshots tab (evidence)`);
  const screenshotsTab = page.locator('button:has-text("Screenshots"), [role="tab"]:has-text("Screenshots"), a:has-text("Screenshots")').first();
  if (await screenshotsTab.count()) {
    await screenshotsTab.click();
    await page.waitForTimeout(1000);
  }
  await scrub(page);
  await page.screenshot({ path: resolve(OUT_DIR, "03-evidence.png"), fullPage: false });

  // ── 02: Progress / step list (re-use the same screening; the Checks tab
  //       shows the per-source step list that doubles as the live-progress UI) ──
  console.log(`[02] checks tab (step list / progress UI)`);
  const checksTab = page.locator('button:has-text("Checks"), [role="tab"]:has-text("Checks"), a:has-text("Checks")').first();
  if (await checksTab.count()) {
    await checksTab.click();
    await page.waitForTimeout(1000);
  }
  await scrub(page);
  await page.screenshot({ path: resolve(OUT_DIR, "02-progress.png"), fullPage: false });

  await browser.close();
  console.log(`\n✓ Wrote 4 screenshots to ${OUT_DIR}`);
  console.log(`Next: render the audit PDF to PNG via scripts/render-pdf-hero.sh`);
}

main().catch(err => { console.error(err); process.exit(1); });
