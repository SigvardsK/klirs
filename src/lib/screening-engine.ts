/**
 * Screening engine — Playwright orchestration + tri-state classifier.
 *
 * LOAD-BEARING INVARIANT (read this before modifying classifyResult below):
 *
 *   The engine NEVER defaults to `clear`. A `clear` verdict requires a positive
 *   no-results indicator from the source page. A `hit` verdict requires a positive
 *   match indicator (substring or regex). Anything else is `uncertain`, surfaced for
 *   human review. Modifying this contract has historically produced silent false-
 *   negative regressions on sanctioned individuals — the worst possible failure mode
 *   for a compliance tool.
 *
 *   Before merging changes that touch classifyResult, db-configs.ts, or risk-score.ts:
 *     npm run smoke:sanctioned
 *
 *   The smoke test asserts that known-sanctioned individuals (Petr Aven, Ramzan
 *   Kadyrov, Pjotrs Avens) never return `clear` on any sanctions source. If it
 *   exits non-zero, do not merge.
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Page, Browser, BrowserContext } from "playwright";

// Apply stealth plugin — patches CDP detection, navigator.webdriver, and other automation signals
chromium.use(StealthPlugin());
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SEARCHABLE_DATABASES, ADVERSE_MEDIA_CONFIG, COMPANY_REGISTRY_CONFIG, type DbConfig } from "./db-configs";
import { isLatviaJurisdiction } from "./jurisdiction";
import { expandLvVariants } from "./name-variants";
import { detectAdversarialInput, adversarialReason } from "./adversarial-input";
import type { Person, ScreeningCheck } from "./types";
import { classifyWithJev, jevEnabled } from "./jev-verdict";
import { runPool, createKeyedMutex } from "./check-pool";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

interface ScreeningJob {
  screeningId: string;
  entityName: string;
  entityType: "company" | "individual";
  jurisdiction: string;
  registrationNumber: string | null;
  persons: Person[];
}

/**
 * Thrown when a target source returns an HTTP-level rate-limit / blocked response
 * (429, 403). Distinguished from generic `error` because the failure mode is
 * recoverable on retry — the user-facing surface should be a yellow "source
 * temporarily unavailable" badge, not a red error. The screening still ships
 * with whatever evidence the remaining sources produced.
 *
 * Detection: `runDatabaseCheck` captures the navigation response from `page.goto`
 * and inspects `.status()`. If 429 or 403, throws this. The screening loop's
 * catch handler renders the prefixed `details` field (`[RATE_LIMITED] …`) which
 * the UI parses to render the distinct badge.
 *
 * Out of scope (deferred to Phase B / post-revenue): exponential backoff, per-
 * source token bucket, automated proxy rotation, multi-region failover.
 */
export class RateLimitError extends Error {
  readonly httpStatus: number;
  readonly retryAfter: string | null;
  readonly sourceName: string;

  constructor(sourceName: string, httpStatus: number, retryAfter: string | null) {
    super(
      `[RATE_LIMITED] ${sourceName} returned HTTP ${httpStatus}` +
        (retryAfter ? ` (Retry-After: ${retryAfter})` : "")
    );
    this.name = "RateLimitError";
    this.httpStatus = httpStatus;
    this.retryAfter = retryAfter;
    this.sourceName = sourceName;
  }
}

/**
 * Format the `details` field consistently for any error that goes into
 * `screening_checks`. Uses `[RATE_LIMITED]` prefix for RateLimitError so the UI
 * can render a yellow badge instead of the generic red error. Magic-prefix
 * approach (vs a separate column) keeps this a code-only change with no schema
 * migration risk in the current deploy cycle.
 */
export function formatErrorDetail(err: unknown): string {
  if (err instanceof RateLimitError) {
    return err.message; // Already prefixed in the constructor.
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "Unknown error";
}

function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
}

/**
 * Calculate total checks for a screening job. Each person's aliases generate an
 * additional check per sanctions/adverse-media database, so the total fans out.
 * Variants from `expandLvVariants` (LV transliteration heuristic) also fan out.
 */
export function calculateTotalChecks(job: ScreeningJob): number {
  let total = 0;
  const isLatvia = isLatviaJurisdiction(job.jurisdiction);
  const searchTerms = buildSearchTerms(job);
  const personVariantCount = searchTerms.persons.reduce(
    (sum, p) => sum + p.variants.length,
    0
  );
  const companyVariantCount = searchTerms.companyVariants.length;

  for (const db of SEARCHABLE_DATABASES) {
    // Latvia-national sources (VID PEP) run only for LV screenings — keep this in
    // lockstep with the runScreening loop so the progress total matches the rows
    // actually written.
    if (db.latviaOnly && !isLatvia) continue;
    if (db.personsOnly) {
      total += personVariantCount;
    } else if (db.companyOnly) {
      total += companyVariantCount;
    } else if (job.entityType === "individual") {
      // Individual entity: entity name IS the primary person, no separate company slot.
      total += personVariantCount;
    } else {
      total += companyVariantCount + personVariantCount;
    }
  }

  // Adverse media: each person variant × 4 languages
  total += personVariantCount * 4;

  // Company registry: 3 checks (search results + company detail + persons tab).
  // Latvia-only source — skipped for non-LV jurisdictions.
  if (job.entityType === "company" && isLatvia) {
    total += 3;
  }

  return total;
}

interface PersonTerms {
  primary: string;
  variants: string[]; // primary + aliases + LV-transliteration variants (deduped)
}

interface SearchTerms {
  company: string;
  // Original company name + LV-transliteration variants (deduped). Used for sanctions
  // queries on company entities and the company slot in mixed DBs.
  companyVariants: string[];
  persons: PersonTerms[];
}

function buildSearchTerms(job: ScreeningJob): SearchTerms {
  const persons: PersonTerms[] = [];
  for (const p of job.persons) {
    const primary = p.name.trim();
    if (!primary) continue;
    const aliases = (p.aliases || [])
      .map(a => a.trim())
      .filter(a => a.length > 0 && a !== primary);
    // Each user-supplied variant (primary + each alias) is fed through the
    // LV transliteration heuristic. Set-dedupe across the whole person.
    // Without auto-expansion, "Pjotr Avens" with no aliases returns all-clear
    // because Firmas indexes "Pjotrs Avens" and OFAC indexes "PETR AVEN", and
    // the engine queries only the literal user input.
    const explicit = [primary, ...Array.from(new Set(aliases))];
    const expanded = new Set<string>();
    for (const v of explicit) {
      for (const e of expandLvVariants(v)) expanded.add(e);
    }
    persons.push({
      primary,
      variants: Array.from(expanded),
    });
  }

  // Same expansion for the company name. "Alfa-Bank" → ["Alfa-Bank", "Alfa-Banks"];
  // "Microsoft Corporation" → 4 variants. Sanctions sources like Firmas with
  // case-sensitive substring search benefit from the morphology variants.
  const companyName = job.entityName.trim();
  const companyVariants = companyName ? expandLvVariants(companyName) : [];

  return { company: job.entityName, companyVariants, persons };
}

/**
 * Run the full screening process.
 * This is the main entry point — call from the API route.
 */
/**
 * Launch headless Chromium with a short retry. A momentarily resource-starved
 * container can fail to fork Chromium's child processes — the browser main
 * process starts, then aborts (SIGTRAP → "browser has been closed"). That is a
 * transient condition: a brief backoff lets the box reclaim process/memory
 * slots. Without a retry, one such blip fails the visitor's ENTIRE screening.
 *
 * This helper only builds and launches the browser — it does NOT touch the
 * tri-state classifier, source indicators, or risk weighting, so the
 * dual-affirmative correctness contract is unaffected.
 */
async function launchBrowserWithRetry(attempts = 3): Promise<Browser> {
  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
  ];
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chromium.launch({ headless: true, args: launchArgs });
    } catch (err) {
      lastErr = err;
      console.warn(
        `[engine] chromium.launch attempt ${i + 1}/${attempts} failed:`,
        err instanceof Error ? err.message : err
      );
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("chromium.launch failed after retries");
}

export async function runScreening(job: ScreeningJob): Promise<void> {
  const supabase = getAdminClient();
  const totalChecks = calculateTotalChecks(job);

  // Update screening status
  await supabase
    .from("screenings")
    .update({ status: "in_progress", checks_total: totalChecks })
    .eq("id", job.screeningId);

  let browser: Browser | null = null;
  let checksCompleted = 0;

  try {
    browser = await launchBrowserWithRetry();

    const context = await browser.newContext({
      viewport: { width: 1280, height: 1024 },
      locale: "en-US",
    });

    let page = await context.newPage();
    const terms = buildSearchTerms(job);
    const isLatvia = isLatviaJurisdiction(job.jurisdiction);

    // 1 + 2. Searchable databases + adverse media — run CONCURRENTLY across
    // sources (Phase B). Each check uses its own ephemeral browser context
    // (session-safe for stateful sites like OFAC; heap bounded, so the old
    // shared-page `recyclePage` workaround is unneeded here), bounded by
    // CHECK_CONCURRENCY, with a per-source mutex so no single source is hit
    // twice at once (rate-limit + session safety). Section 3 (UR SPA) stays
    // sequential below. See DR-20260921 / check-pool.ts.
    const checkConcurrency = Number(process.env.CHECK_CONCURRENCY ?? "4") || 4;
    const perSource = createKeyedMutex();
    const languages = ["LV", "EN", "ET", "RU"] as const;
    const personVariants: string[] = terms.persons.flatMap((p) => p.variants);

    const tasks: Array<() => Promise<void>> = [];
    for (const db of SEARCHABLE_DATABASES) {
      // Latvia-national sources (VID PEP) only apply to a Latvian entity. For a
      // non-LV jurisdiction they are not part of the screen (LR-WS-2026-029).
      if (db.latviaOnly && !isLatvia) continue;
      for (const searchTerm of getSearchItems(db, terms, job.entityType)) {
        tasks.push(() =>
          perSource(db.id, () =>
            runSearchableCheckIsolated(browser!, supabase, job, db, searchTerm),
          ),
        );
      }
    }
    for (const personName of personVariants) {
      for (const lang of languages) {
        tasks.push(() =>
          perSource(`adverse_${lang}`, () =>
            runAdverseMediaCheckIsolated(browser!, supabase, job, personName, lang),
          ),
        );
      }
    }

    await runPool(tasks, checkConcurrency, async () => {
      checksCompleted++;
      await supabase
        .from("screenings")
        .update({ checks_completed: checksCompleted })
        .eq("id", job.screeningId);
    });

    // 3. Company registry (SPA — 3 screenshots: search results + company detail + persons tab).
    // Uzņēmumu reģistrs is a Latvian national registry — LV company entities only.
    // A non-LV company is screened against sanctions + adverse media only.
    if (job.entityType === "company" && isLatvia) {
      // Prefer registration number when provided — it is unambiguous; many
      // company names are non-unique in the registry, so a name-search can
      // return the wrong entity. UR's single search input accepts either via
      // the same `q=` query parameter.
      const urSearchTerm = job.registrationNumber?.trim() || job.entityName;

      try {
        // UR detail pages + result cards benefit from extra viewport height to
        // show the first 2–3 items without fullPage scrolling.
        await page.setViewportSize({ width: 1280, height: COMPANY_REGISTRY_CONFIG.viewportHeight || 1024 });
        // UR's SPA pulls many third-party trackers that keep the network busy
        // long after the page is interactive. `networkidle` here was a known
        // hang/heap-pressure surface that produced a 3-day stall; the real
        // load gate is the search-input waitForFunction below, so dom-ready
        // is sufficient.
        await page.goto(COMPANY_REGISTRY_CONFIG.url, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        await dismissCookies(page, COMPANY_REGISTRY_CONFIG.cookieSelector);

        // Wait for SPA to fully render the search input
        await page.waitForFunction(() => {
          const input = document.querySelector('input[placeholder*="Uzņēmuma nosaukums"]');
          return input && (input as HTMLElement).offsetHeight > 0;
        }, { timeout: 15000 });

        // Fill search using native value setter (React controlled input)
        const searchInput = page.locator('input.DataSearch-input').first();
        await searchInput.click();
        await sleep(300);
        await page.evaluate((term) => {
          const input = document.querySelector('input.DataSearch-input') as HTMLInputElement;
          if (!input) return;
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set;
          nativeInputValueSetter?.call(input, term);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, urSearchTerm);
        await sleep(1000);
        await searchInput.press("Enter");
        await sleep(COMPANY_REGISTRY_CONFIG.waitMs);

        // Screenshot 1: Search results
        await injectEvidenceHeader(page, "Company Registry — Search (Latvia)", urSearchTerm);
        const searchScreenshot = await uploadScreenshot(
          supabase, job.screeningId, page,
          { ...COMPANY_REGISTRY_CONFIG, filenamePrefix: "ur_registry_search" },
          urSearchTerm
        );
        await supabase.from("screening_checks").insert({
          screening_id: job.screeningId,
          database_name: `${COMPANY_REGISTRY_CONFIG.name} — Search`,
          category: "company_registry",
          search_term: urSearchTerm,
          status: "clear",
          screenshot_path: searchScreenshot,
          source_url: safePageUrl(page),
          checked_at: new Date().toISOString(),
        });

        checksCompleted++;
        await supabase.from("screenings")
          .update({ checks_completed: checksCompleted })
          .eq("id", job.screeningId);

        // Screenshot 2: Click first result → company detail page
        const firstResult = page.locator('a.Anchor[href*="/legal-entity/"]').first();
        if (await firstResult.isVisible({ timeout: 3000 })) {
          await firstResult.click();
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
          await sleep(5000);

          await injectEvidenceHeader(page, "Company Registry — Detail (Latvia)", urSearchTerm);
          const detailScreenshot = await uploadScreenshot(
            supabase, job.screeningId, page,
            { ...COMPANY_REGISTRY_CONFIG, filenamePrefix: "ur_registry_detail" },
            urSearchTerm
          );
          await supabase.from("screening_checks").insert({
            screening_id: job.screeningId,
            database_name: `${COMPANY_REGISTRY_CONFIG.name} — Detail`,
            category: "company_registry",
            search_term: urSearchTerm,
            status: "clear",
            screenshot_path: detailScreenshot,
            source_url: safePageUrl(page),
            checked_at: new Date().toISOString(),
          });

          checksCompleted++;
          await supabase.from("screenings")
            .update({ checks_completed: checksCompleted })
            .eq("id", job.screeningId);

          // Screenshot 3: Personas tab (directors / shareholders / beneficial
          // owners). react-tabs renders each tab as <li class="react-tabs__tab">;
          // clicking swaps the panel content in place. Graceful fallback: if
          // the tab isn't found or click fails, skip without failing the run.
          try {
            const personsTab = page.locator('li.react-tabs__tab', { hasText: 'Personas' }).first();
            if (await personsTab.isVisible({ timeout: 3000 })) {
              await personsTab.click();
              await sleep(2500); // react-tabs panel swap + any lazy row fetches
              // The Persons tab stacks 4 sections vertically — Dalībnieki,
              // Amatpersonas, Prokūras, and Patiesie labuma guvēji (UBOs). At
              // the 1400 viewport used for Search + Detail, the UBO section
              // sits below the fold. Extend to 1800 for this screenshot so all
              // four sections are visible — the UBO row is the compliance-
              // critical one.
              await page.setViewportSize({ width: 1280, height: 1800 });
              await sleep(500); // let the layout reflow after resize
              await injectEvidenceHeader(page, "Company Registry — Persons (Latvia)", urSearchTerm);
              const personsScreenshot = await uploadScreenshot(
                supabase, job.screeningId, page,
                { ...COMPANY_REGISTRY_CONFIG, filenamePrefix: "ur_registry_persons" },
                urSearchTerm
              );
              await supabase.from("screening_checks").insert({
                screening_id: job.screeningId,
                database_name: `${COMPANY_REGISTRY_CONFIG.name} — Persons`,
                category: "company_registry",
                search_term: urSearchTerm,
                status: "clear",
                screenshot_path: personsScreenshot,
                source_url: safePageUrl(page),
                checked_at: new Date().toISOString(),
              });
              checksCompleted++;
              await supabase.from("screenings")
                .update({ checks_completed: checksCompleted })
                .eq("id", job.screeningId);
            }
          } catch (err) {
            console.warn("UR Persons tab capture failed:", err);
            // Non-fatal — Pamatinformācija screenshot still covers the entity.
          }
        }
      } catch (err) {
        await supabase.from("screening_checks").insert({
          screening_id: job.screeningId,
          database_name: COMPANY_REGISTRY_CONFIG.name,
          category: "company_registry",
          search_term: urSearchTerm,
          status: "error",
          details: formatErrorDetail(err),
          source_url: safePageUrl(page),
          checked_at: new Date().toISOString(),
        });
        checksCompleted++;
        await supabase.from("screenings")
          .update({ checks_completed: checksCompleted })
          .eq("id", job.screeningId);
      }
    }

    // Mark screening as completed
    await supabase
      .from("screenings")
      .update({
        status: "completed",
        checks_completed: checksCompleted,
        completed_at: new Date().toISOString(),
      })
      .eq("id", job.screeningId);

  } catch (err) {
    console.error("Screening failed:", err);
    await supabase
      .from("screenings")
      .update({ status: "failed" })
      .eq("id", job.screeningId);
  } finally {
    if (browser) await browser.close();
  }
}

// ── Phase B: isolated per-check helpers ────────────────────────────────────
// Each check runs in its OWN browser context so checks parallelise safely
// (stateful sites like OFAC's ASP.NET don't collide on session state) and the
// heap is bounded per check (making the old shared-page `recyclePage` workaround
// unnecessary for these sections). Each persists its own row — success or error —
// exactly as the sequential loop did. Progress counting is the caller's job.

async function runSearchableCheckIsolated(
  browser: Browser,
  supabase: SupabaseClient,
  job: ScreeningJob,
  db: DbConfig,
  searchTerm: string,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
    locale: "en-US",
  });
  const page = await context.newPage();
  try {
    const result = await runDatabaseCheck(page, db, searchTerm);
    // Downgrade `hit` → `uncertain` for sources with known company-query noise
    // (e.g. UK Sanctions' tokenised multi-word search). Evidence still persists.
    if (db.downgradeCompanyHits && job.entityType === "company" && result.status === "hit") {
      result.status = "uncertain";
      result.reason =
        `${db.name} uses tokenised multi-word search across all fields, so any 'hit' on a multi-word company name may be a tokenisation artefact (e.g. 'Corporation' matches 137 records). Manually review the screenshot before treating as a confirmed match.`;
    }
    const screenshotPath = await uploadScreenshot(supabase, job.screeningId, page, db, searchTerm);
    await supabase.from("screening_checks").insert({
      screening_id: job.screeningId,
      database_name: db.name,
      category: db.category,
      search_term: searchTerm,
      status: result.status,
      details: formatCheckDetails(result),
      screenshot_path: screenshotPath,
      source_url: safePageUrl(page),
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    await supabase.from("screening_checks").insert({
      screening_id: job.screeningId,
      database_name: db.name,
      category: db.category,
      search_term: searchTerm,
      status: "error",
      details: formatErrorDetail(err),
      source_url: safePageUrl(page),
      checked_at: new Date().toISOString(),
    });
  } finally {
    await sleep(db.rateLimit); // per-source pacing (held under the source mutex)
    await context.close().catch(() => {});
  }
}

async function runAdverseMediaCheckIsolated(
  browser: Browser,
  supabase: SupabaseClient,
  job: ScreeningJob,
  personName: string,
  lang: "LV" | "EN" | "ET" | "RU",
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: ADVERSE_MEDIA_CONFIG.viewportHeight || 1024 },
    locale: "en-US",
  });
  const page = await context.newPage();
  try {
    const template = ADVERSE_MEDIA_CONFIG.searchTemplates?.[lang] || "";
    const query = template.replace("{name}", personName);
    const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;

    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(ADVERSE_MEDIA_CONFIG.waitMs);

    let pageText = await page.textContent("body").catch(() => "");
    const looksBlocked = (t: string | null) =>
      !t || t.length < 200 ||
      t.includes("Unexpected error") ||
      t.includes("bots use DuckDuckGo") ||
      t.includes("Select all squares") ||
      t.includes("unusual traffic") ||
      t.includes("not a robot");

    if (looksBlocked(pageText)) {
      console.warn(`DDG blocked for ${personName} (${lang}), retrying in 60s...`);
      await sleep(60000);
      await page.reload({ waitUntil: "domcontentloaded" });
      await sleep(ADVERSE_MEDIA_CONFIG.waitMs);
      pageText = await page.textContent("body").catch(() => "");
      if (looksBlocked(pageText)) {
        throw new Error("Search engine blocked automated access after retry");
      }
    }

    await injectEvidenceHeader(page, `Adverse Media (${lang})`, personName);
    const screenshotPath = await uploadScreenshot(
      supabase, job.screeningId, page,
      { ...ADVERSE_MEDIA_CONFIG, filenamePrefix: `adverse_media_${lang.toLowerCase()}` },
      personName,
    );

    // Tri-state string-match, refined by Jev when enabled (fallback-safe).
    const deterministic = classifyResult(pageText || "", ADVERSE_MEDIA_CONFIG, personName);
    const adverseMediaResult = jevEnabled()
      ? await classifyWithJev(pageText || "", ADVERSE_MEDIA_CONFIG, personName, deterministic)
      : deterministic;
    await supabase.from("screening_checks").insert({
      screening_id: job.screeningId,
      database_name: `Adverse Media (${lang})`,
      category: "adverse_media",
      search_term: `${personName} (${lang})`,
      status: adverseMediaResult.status,
      details: formatCheckDetails(adverseMediaResult),
      screenshot_path: screenshotPath,
      source_url: safePageUrl(page),
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    const errorScreenshotPath = await uploadScreenshot(
      supabase, job.screeningId, page,
      { ...ADVERSE_MEDIA_CONFIG, filenamePrefix: `adverse_media_${lang.toLowerCase()}` },
      personName,
    ).catch(() => null);
    await supabase.from("screening_checks").insert({
      screening_id: job.screeningId,
      database_name: `Adverse Media (${lang})`,
      category: "adverse_media",
      search_term: `${personName} (${lang})`,
      status: "error",
      details: formatErrorDetail(err),
      screenshot_path: errorScreenshotPath,
      source_url: safePageUrl(page),
      checked_at: new Date().toISOString(),
    });
  } finally {
    await sleep(ADVERSE_MEDIA_CONFIG.rateLimit);
    await context.close().catch(() => {});
  }
}

function getSearchItems(
  db: DbConfig,
  terms: SearchTerms,
  entityType: "company" | "individual"
): string[] {
  const personVariants = terms.persons.flatMap(p => p.variants);
  if (db.personsOnly) return personVariants;
  if (db.companyOnly) return terms.companyVariants;
  // For an individual entity, the entity name IS the primary person variant —
  // the engine already iterates persons, so skip the company slot to avoid a
  // duplicate search on the same string.
  if (entityType === "individual") return personVariants;
  return [...terms.companyVariants, ...personVariants];
}

async function dismissCookies(page: Page, dbCookieSelector: string | null): Promise<void> {
  // 1. Try database-specific cookie selector first
  if (dbCookieSelector) {
    try {
      await page.locator(dbCookieSelector).first().click({ timeout: 2000 });
      await sleep(500);
      return;
    } catch {
      console.warn(`Cookie dismiss failed for selector "${dbCookieSelector}" on ${page.url()}`);
    }
  }

  // 2. Try common cookie consent button selectors
  const commonSelectors = [
    // Reject/decline buttons (preferred — less tracking)
    'button:has-text("Reject")',
    'button:has-text("Noraidīt")',
    'button:has-text("Nepiekrītu")',
    'button:has-text("Decline")',
    // Accept/agree buttons (fallback)
    'button:has-text("Accept")',
    'button:has-text("Piekrītu")',
    'button:has-text("Pieņemt")',
    'button:has-text("Agree")',
    'button:has-text("OK")',
    // Common class patterns
    '.cookie-reject-all',
    '.cookie-accept',
    '[data-cookie-accept]',
    '#cookie-accept',
    '.cc-dismiss',
    '.cc-btn',
  ];

  for (const selector of commonSelectors) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 500 })) {
        await button.click({ timeout: 1000 });
        await sleep(300);
        return;
      }
    } catch {
      // Continue to next selector
    }
  }

  // 3. Last resort: remove cookie overlays from DOM entirely
  try {
    await page.evaluate(() => {
      // Remove elements by cookie-related TEXT content (catches banners with non-standard class names)
      const cookieTextIndicators = ['sīkdatne', 'sīkdatņ', 'sikdat', 'cookie'];
      document.querySelectorAll('div, section, aside, footer').forEach(el => {
        const text = (el as HTMLElement).innerText?.toLowerCase() || '';
        if (text.length < 500 && cookieTextIndicators.some(ind => text.includes(ind))) {
          // Only remove if it's a banner-like element (not the whole page)
          const rect = el.getBoundingClientRect();
          if (rect.height < 200) {
            el.remove();
          }
        }
      });

      // Remove elements with cookie-related class/id names
      const selectors = [
        '[class*="cookie"]', '[id*="cookie"]',
        '[class*="consent"]', '[id*="consent"]',
        '[class*="gdpr"]', '[id*="gdpr"]',
        '[class*="sikdat"]', '[id*="sikdat"]', // Latvian: sīkdatne = cookie
        '.cc-window', '.cc-banner',
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach(el => el.remove());
      }

      // Catch-all: remove any fixed/sticky element anchored to the bottom of the viewport
      // (cookie banners universally live here, regardless of class names)
      // Skip our own evidence header (id="aml-evidence-header")
      document.querySelectorAll('*').forEach(el => {
        if (el.id === 'aml-evidence-header') return;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if ((style.position === 'fixed' || style.position === 'sticky') &&
            rect.bottom >= window.innerHeight - 10 && rect.height < 200) {
          el.remove();
        }
      });
    });
    await sleep(300);
  } catch {
    // Non-critical — continue without cookie dismissal
  }
}

export interface CheckResult {
  status: "clear" | "hit" | "uncertain";
  reason?: string;
  // First ~2000 chars of the captured page text. Persisted into the
  // screening_checks.details column for hit/uncertain rows so future
  // forensics ("why was this uncertain?") doesn't require OCRing the
  // screenshot. Without this field, the engine throws away the page text
  // after classification, leaving only the classifier reason in `details`.
  //
  // Window sizing: 2000 chars is empirically tuned. OFAC's ASP.NET page
  // emits ~450 chars of JS boilerplate (`__doPostBack`, form submitters)
  // at the top of body.textContent before any meaningful content — a
  // 500-char excerpt was nearly all noise. 2000 chars covers past the
  // boilerplate and captures the `Lookup Results: N Found` heading +
  // first result row.
  pageTextExcerpt?: string;
}

const PAGE_TEXT_EXCERPT_CHARS = 2000;

/**
 * Classify a single database query result.
 *
 * Precedence:
 *   1. noResultsIndicator text present       → `clear`
 *   2. hitIndicatorPattern (regex) matches   → `hit`   (count-aware sources, e.g. OFAC)
 *   3. hitIndicator (substring) matches      → `hit`   (UK, Firmas)
 *   4. noResultsIndicator configured
 *      but text absent                       → `uncertain` (likely a match, needs human review)
 *   5. no indicators configured              → `uncertain`
 *
 * The engine NEVER defaults to `clear` — doing so means a sanctioned entity
 * returns a green badge (the load-bearing false-negative this contract prevents).
 * `clear` is an affirmative state that requires positive confirmation; absence
 * of signal = review.
 *
 * The regex check (step 2) is run before the substring check (step 3) so a
 * source can express a count-aware match like `Lookup Results: [1-9]+ Found`
 * (OFAC) and have it discriminate hit vs clean even when both pages share the
 * `Lookup Results:` prefix. Failure mode: if the regex misses, classification
 * falls through to substring then to uncertain — never to a false `hit`.
 */
export function classifyResult(
  pageText: string,
  db: Pick<DbConfig, "noResultsIndicator" | "hitIndicator" | "hitIndicatorPattern">,
  // The exact string queried against the source. When provided, the classifier
  // checks for adversarial input classes (Cyrillic, abbreviated initials,
  // hyphen/apostrophe) the engine cannot yet canonicalise. If detected AND
  // the source returned its no-results indicator, the verdict is upgraded
  // from `clear` to `uncertain` so a reviewer confirms manually. See
  // src/lib/adversarial-input.ts and docs/sprint-2/PHONETIC-AUDIT.md for the
  // rationale (LR-WS-2026-029 contract repair pending B6 P0 transformers).
  searchTerm?: string,
): CheckResult {
  const text = pageText.toLowerCase();
  const excerpt = pageText.slice(0, PAGE_TEXT_EXCERPT_CHARS);
  if (db.noResultsIndicator && text.includes(db.noResultsIndicator.toLowerCase())) {
    if (searchTerm) {
      const adversarial = detectAdversarialInput(searchTerm);
      if (adversarial.isAdversarial) {
        return {
          status: "uncertain",
          reason: `Source returned no-results, but input is unreliably canonicalised. ${adversarialReason(adversarial.classes)}`,
          pageTextExcerpt: excerpt,
        };
      }
    }
    return { status: "clear" };
  }
  if (db.hitIndicatorPattern && db.hitIndicatorPattern.test(pageText)) {
    return { status: "hit", pageTextExcerpt: excerpt };
  }
  if (db.hitIndicator && text.includes(db.hitIndicator.toLowerCase())) {
    return { status: "hit", pageTextExcerpt: excerpt };
  }
  if (db.noResultsIndicator) {
    return {
      status: "uncertain",
      reason: "No-results indicator not found — possible match, manual review required",
      pageTextExcerpt: excerpt,
    };
  }
  return {
    status: "uncertain",
    reason: "No result indicators configured for this database",
    pageTextExcerpt: excerpt,
  };
}

/**
 * Build the `details` payload persisted into screening_checks for hit/uncertain
 * rows. Combines the classifier reason (if any) with a page-text excerpt so
 * forensic investigations can reconstruct what classified without OCRing the
 * screenshot. Returns null when there's nothing meaningful to store (e.g. a
 * `hit` where neither reason nor excerpt is set — defensive).
 */
function formatCheckDetails(result: CheckResult): string | null {
  const reason = result.reason ?? null;
  const excerpt = result.pageTextExcerpt
    ? result.pageTextExcerpt.replace(/\s+/g, " ").trim()
    : null;
  if (reason && excerpt) {
    return `${reason} | Page text (first ${PAGE_TEXT_EXCERPT_CHARS} chars): ${excerpt}`;
  }
  if (excerpt) {
    return `Page text (first ${PAGE_TEXT_EXCERPT_CHARS} chars): ${excerpt}`;
  }
  return reason;
}

async function runDatabaseCheck(
  page: Page,
  db: DbConfig,
  searchTerm: string
): Promise<CheckResult> {
  try {
    // Apply per-source viewport (default 1280×1024). Taller viewports surface
    // more rows without resorting to fullPage screenshots. Set before goto so
    // the page's first layout pass uses the final dimensions.
    await page.setViewportSize({ width: 1280, height: db.viewportHeight || 1024 });
    const navResponse = await page.goto(db.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // HTTP-level rate-limit / block detection. `page.goto` returns the navigation
    // response (or null for same-document navigations). 429/403 from a target
    // source means the IP is being throttled or blocked — distinct from a
    // selector-not-found or text-classification failure. Throw the typed error
    // so the catch site can render the yellow "temporarily unavailable" badge
    // rather than the generic red one.
    if (navResponse) {
      const httpStatus = navResponse.status();
      if (httpStatus === 429 || httpStatus === 403) {
        const retryAfter = navResponse.headers()["retry-after"] ?? null;
        await injectEvidenceHeader(page, db.name, searchTerm).catch(() => {});
        throw new RateLimitError(db.name, httpStatus, retryAfter);
      }
    }
    await sleep(1000); // Let cookie banners render

    // Detect Cloudflare/bot protection challenges
    const prePageText = await page.textContent("body").catch(() => "");
    if (prePageText?.includes("Verify you are human") || prePageText?.includes("security verification")) {
      console.warn(`Bot protection detected on ${db.name} (${db.url}) — skipping search`);
      await injectEvidenceHeader(page, db.name, searchTerm);
      throw new Error("Bot protection (Cloudflare) blocked automated access");
    }

    // Dismiss cookies universally
    await dismissCookies(page, db.cookieSelector);

    if (!db.searchSelector) {
      // Page-visit only (jurisdiction checks, company registry SPA).
      // No search was performed — we cannot claim `clear`. Record as uncertain
      // so the UI/downstream treat this as an evidence artefact, not a verdict.
      await sleep(db.waitMs);
      await injectEvidenceHeader(page, db.name, searchTerm);
      return { status: "uncertain", reason: "Page-visit only; no search performed" };
    }

    // Fill the search input(s). Wrapped in a one-retry helper so transient
    // SPA hydration delays and IP-rate-limit flares (observed on UK Sanctions
    // after consecutive Railway calls — red-team 2026-04-24 F1) get a second
    // chance instead of failing the whole check with a `page.fill: Timeout`.
    await fillSearchWithRetry(page, db, searchTerm);

    // Submit
    if (db.submitSelector) {
      if (db.waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({ timeout: db.waitMs }).catch(() => {}),
          page.click(db.submitSelector),
        ]);
        // POST+redirect sources (VID PNP/VAD) render results after a second
        // fetch — waitForNavigation fires on the redirect, but the result
        // table paints later. Settle on networkidle before reading text, so we
        // don't classify a half-rendered page as `uncertain`. Observed failure:
        // Roman Abramovich VAD screenshot captured mid-load → false uncertain.
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      } else {
        await page.click(db.submitSelector);
      }
    } else {
      // Submit via Enter
      await page.keyboard.press("Enter");
    }

    // Wait for results
    await sleep(db.waitMs);

    // Second-chance wait for redirect-style DBs — if the page body is suspiciously
    // short (< 500 chars) after all prior waits, give it one more networkidle
    // cycle. Real VID results pages are > 2000 chars; short body means the table
    // is still painting. Cheap and only retries once.
    if (db.waitForNavigation) {
      const quickPeek = (await page.textContent("body").catch(() => "")) || "";
      if (quickPeek.trim().length < 500) {
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        await sleep(2000);
      }
    }

    // Inject evidence header
    await injectEvidenceHeader(page, db.name, searchTerm);

    // Classify with tri-state precedence (string-match), then refine via Jev when
    // enabled. Jev is additive + fallback-safe: on any failure the string-match
    // verdict is returned verbatim. Covers both the main run and rerunChecks.
    const pageText = (await page.textContent("body").catch(() => "")) || "";
    const deterministic = classifyResult(pageText, db, searchTerm);
    return jevEnabled()
      ? await classifyWithJev(pageText, db, searchTerm, deterministic)
      : deterministic;

  } catch (err) {
    console.error(`Check failed for ${db.name} (${searchTerm}):`, err);
    throw err;
  }
}

// Fill the search input(s) with one retry on timeout.
//
// First attempt uses waitForSelector(8s) + fill — faster to fail than the
// default 30s page.fill implicit wait. On failure we sleep 8s (let any IP
// rate-limit or bot-detection flare cool off), reload the page, dismiss
// cookies again, then try once more. Total worst-case cost: ~20s added to
// a failing check, versus certain error today.
//
// Origin: red-team 2026-04-24 F1 — UK Sanctions #search failed to paint
// after a burst of queries from Railway's datacenter IP. Firmas + OFAC
// still covered verdicts, but the audit trail showed UK error rows.
export async function fillSearchWithRetry(
  page: Page,
  db: DbConfig,
  searchTerm: string
): Promise<void> {
  const attempts = 2;
  const perAttemptTimeoutMs = 8000;
  const cooldownMs = 8000;
  let lastErr: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (db.lastNameSelector) {
        const parts = searchTerm.trim().split(/\s+/);
        const lastName = parts.length > 1 ? parts[parts.length - 1] : parts[0];
        const firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : "";
        await page.waitForSelector(db.searchSelector!, { timeout: perAttemptTimeoutMs, state: "visible" });
        await page.fill(db.searchSelector!, firstName);
        if (db.lastNameSelector) {
          await page.waitForSelector(db.lastNameSelector, { timeout: perAttemptTimeoutMs, state: "visible" });
          await page.fill(db.lastNameSelector, lastName);
        }
      } else {
        await page.waitForSelector(db.searchSelector!, { timeout: perAttemptTimeoutMs, state: "visible" });
        await page.fill(db.searchSelector!, searchTerm);
      }
      return; // success
    } catch (err) {
      lastErr = err;
      if (attempt < attempts - 1) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`${db.name}: search-fill attempt ${attempt + 1}/${attempts} failed (${msg}); reloading + retrying in ${cooldownMs / 1000}s`);
        await sleep(cooldownMs);
        try {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
          await sleep(1500); // cookie banner re-render grace
          await dismissCookies(page, db.cookieSelector);
        } catch (reloadErr) {
          console.warn(`${db.name}: reload between retries failed — continuing to next attempt`, reloadErr);
        }
      }
    }
  }
  throw lastErr;
}

async function injectEvidenceHeader(page: Page, dbName: string, searchTerm: string): Promise<void> {
  const timestamp = new Date().toISOString();
  try {
    await page.evaluate(({ dbName, searchTerm, timestamp }) => {
      const existing = document.getElementById("aml-evidence-header");
      if (existing) existing.remove();

      // Remove any fixed/sticky bottom elements (cookie banners, overlays) before injecting header
      document.querySelectorAll('*').forEach(el => {
        if (el.id === 'aml-evidence-header') return;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        if ((style.position === 'fixed' || style.position === 'sticky') &&
            rect.bottom >= window.innerHeight - 10 && rect.height < 200) {
          el.remove();
        }
      });

      const header = document.createElement("div");
      header.id = "aml-evidence-header";
      header.style.cssText = `
        position: fixed; bottom: 0; left: 0; right: 0; z-index: 2147483647;
        background: #1e293b; color: #e2e8f0; padding: 8px 16px;
        font-family: monospace; font-size: 12px;
        display: flex; justify-content: space-between; align-items: center;
        border-top: 2px solid #10b981;
      `;
      header.innerHTML = `
        <span><strong>Database:</strong> ${dbName}</span>
        <span><strong>Search:</strong> ${searchTerm}</span>
        <span><strong>Captured:</strong> ${timestamp}</span>
      `;
      document.body.prepend(header);
    }, { dbName, searchTerm, timestamp });
  } catch {
    // May fail on some pages — non-critical
  }
}

async function uploadScreenshot(
  supabase: AnySupabaseClient,
  screeningId: string,
  page: Page,
  db: Pick<DbConfig, "filenamePrefix">,
  searchTerm: string
): Promise<string> {
  // Always viewport-only. Height is controlled per-source via
  // DbConfig.viewportHeight, applied via page.setViewportSize() before navigation.
  const screenshot = await page.screenshot({ fullPage: false });
  const safeName = searchTerm.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
  const filename = `${screeningId}/${db.filenamePrefix}_${safeName}_${Date.now()}.png`;

  const { error } = await supabase.storage
    .from("evidence-screenshots")
    .upload(filename, screenshot, {
      contentType: "image/png",
      upsert: false,
    });

  if (error) {
    console.error("Screenshot upload failed:", error);
    throw error;
  }

  return filename;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Close the current page and open a fresh one in the same context.
// Releases per-page DOM/JS heap; browser stays alive (re-launch is expensive).
// Tolerates a close-failure (page already closed) without throwing.
async function recyclePage(page: Page, context: BrowserContext): Promise<Page> {
  try { await page.close(); } catch { /* page already gone */ }
  return await context.newPage();
}

// page.url() can throw if the page was closed or is in an invalid state
// (mid-navigation errors). Return null so the insert still succeeds.
function safePageUrl(page: Page): string | null {
  try {
    const url = page.url();
    return url && url !== "about:blank" ? url : null;
  } catch {
    return null;
  }
}

// ===========================================================================
// Granular re-run (Outlast MCP — 2026-09-21)
// ---------------------------------------------------------------------------
// Re-screens SPECIFIC checks by id, so a reviewer can refresh a single source
// (or the company-registry block) without re-running the whole 40+ screen.
//
// runScreening above is left VERBATIM. The per-item logic here MIRRORS its
// three sections deliberately (sanctions/PEP via runDatabaseCheck; adverse
// media via the DuckDuckGo flow; company registry as a 3-screenshot block) so
// the proven full-screen path carries zero regression risk from this feature.
//
// Row -> re-run path:
//   category "company_registry"  -> registry block (re-runs all 3 UR rows once)
//   category "adverse_media"     -> DuckDuckGo re-run for that person+language
//   otherwise                    -> SEARCHABLE_DATABASES[name] via runDatabaseCheck
// The caller regenerates the report after this returns.
// ===========================================================================

export interface RerunOutcome {
  screening_id: string;
  rerun: { check_id: string; database_name: string; old_status: string; new_status: string }[];
  registry_block_rerun: boolean;
  skipped: { check_id: string; database_name: string; reason: string }[];
  errors: { check_id?: string; database_name?: string; message: string }[];
}

// Re-run one adverse-media (DuckDuckGo) query for a person + language. Mirrors
// section 2 of runScreening. Returns the new verdict + fresh screenshot path.
async function rerunAdverseMediaItem(
  supabase: AnySupabaseClient,
  page: Page,
  screeningId: string,
  personName: string,
  lang: string
): Promise<{ status: string; details: string | null; shot: string; sourceUrl: string | null }> {
  await page.setViewportSize({ width: 1280, height: ADVERSE_MEDIA_CONFIG.viewportHeight || 1024 });
  const template = ADVERSE_MEDIA_CONFIG.searchTemplates?.[lang] || ADVERSE_MEDIA_CONFIG.searchTemplates?.["EN"] || "";
  const query = template.replace("{name}", personName);
  const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(ADVERSE_MEDIA_CONFIG.waitMs);
  const isBlocked = (t: string | null) =>
    !t || t.length < 200 ||
    t.includes("Unexpected error") || t.includes("bots use DuckDuckGo") ||
    t.includes("Select all squares") || t.includes("unusual traffic") || t.includes("not a robot");
  let pageText = await page.textContent("body").catch(() => "");
  if (isBlocked(pageText)) {
    await sleep(60000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await sleep(ADVERSE_MEDIA_CONFIG.waitMs);
    pageText = await page.textContent("body").catch(() => "");
    if (isBlocked(pageText)) throw new Error("Search engine blocked automated access after retry");
  }
  await injectEvidenceHeader(page, `Adverse Media (${lang})`, personName);
  const shot = await uploadScreenshot(
    supabase, screeningId, page,
    { ...ADVERSE_MEDIA_CONFIG, filenamePrefix: `adverse_media_${lang.toLowerCase()}` },
    personName
  );
  const res = classifyResult(pageText || "", ADVERSE_MEDIA_CONFIG, personName);
  return { status: res.status, details: formatCheckDetails(res), shot, sourceUrl: safePageUrl(page) };
}

// Re-run the Latvian company-registry (UR) block: Search + Detail + Persons.
// Mirrors section 3 of runScreening (minus the progress-counter updates, since a
// re-run replaces existing rows rather than adding to the total). Inserts fresh
// rows; the caller has already deleted the previous UR rows.
async function rerunCompanyRegistry(
  supabase: AnySupabaseClient,
  page: Page,
  job: { screeningId: string; entityName: string; registrationNumber: string | null }
): Promise<void> {
  const urSearchTerm = job.registrationNumber?.trim() || job.entityName;
  try {
    await page.setViewportSize({ width: 1280, height: COMPANY_REGISTRY_CONFIG.viewportHeight || 1024 });
    await page.goto(COMPANY_REGISTRY_CONFIG.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissCookies(page, COMPANY_REGISTRY_CONFIG.cookieSelector);
    await page.waitForFunction(() => {
      const input = document.querySelector('input[placeholder*="Uzņēmuma nosaukums"]');
      return input && (input as HTMLElement).offsetHeight > 0;
    }, { timeout: 15000 });
    const searchInput = page.locator('input.DataSearch-input').first();
    await searchInput.click();
    await sleep(300);
    await page.evaluate((term) => {
      const input = document.querySelector('input.DataSearch-input') as HTMLInputElement;
      if (!input) return;
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      )?.set;
      nativeInputValueSetter?.call(input, term);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, urSearchTerm);
    await sleep(1000);
    await searchInput.press("Enter");
    await sleep(COMPANY_REGISTRY_CONFIG.waitMs);

    await injectEvidenceHeader(page, "Company Registry — Search (Latvia)", urSearchTerm);
    const searchScreenshot = await uploadScreenshot(
      supabase, job.screeningId, page,
      { ...COMPANY_REGISTRY_CONFIG, filenamePrefix: "ur_registry_search" }, urSearchTerm
    );
    await supabase.from("screening_checks").insert({
      screening_id: job.screeningId,
      database_name: `${COMPANY_REGISTRY_CONFIG.name} — Search`,
      category: "company_registry",
      search_term: urSearchTerm,
      status: "clear",
      screenshot_path: searchScreenshot,
      source_url: safePageUrl(page),
      checked_at: new Date().toISOString(),
    });

    const firstResult = page.locator('a.Anchor[href*="/legal-entity/"]').first();
    if (await firstResult.isVisible({ timeout: 3000 })) {
      await firstResult.click();
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await sleep(5000);
      await injectEvidenceHeader(page, "Company Registry — Detail (Latvia)", urSearchTerm);
      const detailScreenshot = await uploadScreenshot(
        supabase, job.screeningId, page,
        { ...COMPANY_REGISTRY_CONFIG, filenamePrefix: "ur_registry_detail" }, urSearchTerm
      );
      await supabase.from("screening_checks").insert({
        screening_id: job.screeningId,
        database_name: `${COMPANY_REGISTRY_CONFIG.name} — Detail`,
        category: "company_registry",
        search_term: urSearchTerm,
        status: "clear",
        screenshot_path: detailScreenshot,
        source_url: safePageUrl(page),
        checked_at: new Date().toISOString(),
      });

      try {
        const personsTab = page.locator('li.react-tabs__tab', { hasText: 'Personas' }).first();
        if (await personsTab.isVisible({ timeout: 3000 })) {
          await personsTab.click();
          await sleep(2500);
          await page.setViewportSize({ width: 1280, height: 1800 });
          await sleep(500);
          await injectEvidenceHeader(page, "Company Registry — Persons (Latvia)", urSearchTerm);
          const personsScreenshot = await uploadScreenshot(
            supabase, job.screeningId, page,
            { ...COMPANY_REGISTRY_CONFIG, filenamePrefix: "ur_registry_persons" }, urSearchTerm
          );
          await supabase.from("screening_checks").insert({
            screening_id: job.screeningId,
            database_name: `${COMPANY_REGISTRY_CONFIG.name} — Persons`,
            category: "company_registry",
            search_term: urSearchTerm,
            status: "clear",
            screenshot_path: personsScreenshot,
            source_url: safePageUrl(page),
            checked_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.warn("UR Persons tab capture failed (re-run):", err);
      }
    }
  } catch (err) {
    await supabase.from("screening_checks").insert({
      screening_id: job.screeningId,
      database_name: COMPANY_REGISTRY_CONFIG.name,
      category: "company_registry",
      search_term: urSearchTerm,
      status: "error",
      details: formatErrorDetail(err),
      source_url: safePageUrl(page),
      checked_at: new Date().toISOString(),
    });
  }
}

export async function rerunChecks(screeningId: string, checkIds: string[]): Promise<RerunOutcome> {
  const supabase = getAdminClient();
  const outcome: RerunOutcome = {
    screening_id: screeningId, rerun: [], registry_block_rerun: false, skipped: [], errors: [],
  };

  const { data: scr, error: scrErr } = await supabase
    .from("screenings").select("*").eq("id", screeningId).single();
  if (scrErr || !scr) throw new Error(`Screening not found: ${screeningId}`);

  const { data: rowData, error: rowErr } = await supabase
    .from("screening_checks").select("*").eq("screening_id", screeningId).in("id", checkIds);
  if (rowErr) throw new Error(`Failed to load checks: ${rowErr.message}`);
  const rows = (rowData ?? []) as ScreeningCheck[];
  if (rows.length === 0) throw new Error("No matching checks for the given ids.");

  const configByName = new Map<string, DbConfig>();
  for (const d of SEARCHABLE_DATABASES) configByName.set(d.name, d);

  const isRegistry = (r: ScreeningCheck) =>
    r.category === "company_registry" || r.database_name.startsWith(COMPANY_REGISTRY_CONFIG.name);
  const isAdverse = (r: ScreeningCheck) =>
    r.category === "adverse_media" || r.database_name.startsWith("Adverse Media");
  const registryRows = rows.filter(isRegistry);
  const adverseRows = rows.filter(isAdverse);
  const simpleRows = rows.filter((r) => !isRegistry(r) && !isAdverse(r));

  let browser: Browser | null = null;
  try {
    browser = await launchBrowserWithRetry();
    const context = await browser.newContext({ viewport: { width: 1280, height: 1024 }, locale: "en-US" });
    let page = await context.newPage();

    // 1) Sanctions / PEP — reuse runDatabaseCheck exactly as the main run does.
    for (const row of simpleRows) {
      const db = configByName.get(row.database_name);
      if (!db) {
        outcome.skipped.push({ check_id: row.id, database_name: row.database_name, reason: "no matching source config" });
        continue;
      }
      try {
        const res = await runDatabaseCheck(page, db, row.search_term);
        if (db.downgradeCompanyHits && scr.entity_type === "company" && res.status === "hit") {
          res.status = "uncertain";
          res.reason = `${db.name} uses tokenised multi-word search across all fields, so any 'hit' on a multi-word company name may be a tokenisation artefact. Manually review the screenshot before treating as a confirmed match.`;
        }
        const shot = await uploadScreenshot(supabase, screeningId, page, db, row.search_term);
        await supabase.from("screening_checks").update({
          status: res.status, details: formatCheckDetails(res), screenshot_path: shot,
          source_url: safePageUrl(page), checked_at: new Date().toISOString(),
        }).eq("id", row.id);
        if (row.screenshot_path) {
          await supabase.storage.from("evidence-screenshots").remove([row.screenshot_path]).catch(() => {});
        }
        outcome.rerun.push({ check_id: row.id, database_name: row.database_name, old_status: row.status, new_status: res.status });
      } catch (err) {
        await supabase.from("screening_checks").update({
          status: "error", details: formatErrorDetail(err), source_url: safePageUrl(page), checked_at: new Date().toISOString(),
        }).eq("id", row.id);
        outcome.errors.push({ check_id: row.id, database_name: row.database_name, message: formatErrorDetail(err) });
      }
      await sleep(db.rateLimit);
    }

    // 2) Adverse media — DuckDuckGo re-run per person + language.
    for (const row of adverseRows) {
      const langMatch = row.database_name.match(/Adverse Media \(([^)]+)\)/);
      const lang = langMatch?.[1] ?? "EN";
      const personName = row.search_term.replace(/\s*\([^)]+\)\s*$/, "").trim();
      try {
        const r = await rerunAdverseMediaItem(supabase, page, screeningId, personName, lang);
        await supabase.from("screening_checks").update({
          status: r.status, details: r.details, screenshot_path: r.shot,
          source_url: r.sourceUrl, checked_at: new Date().toISOString(),
        }).eq("id", row.id);
        if (row.screenshot_path) {
          await supabase.storage.from("evidence-screenshots").remove([row.screenshot_path]).catch(() => {});
        }
        outcome.rerun.push({ check_id: row.id, database_name: row.database_name, old_status: row.status, new_status: r.status });
      } catch (err) {
        await supabase.from("screening_checks").update({
          status: "error", details: formatErrorDetail(err), checked_at: new Date().toISOString(),
        }).eq("id", row.id);
        outcome.errors.push({ check_id: row.id, database_name: row.database_name, message: formatErrorDetail(err) });
      }
      await sleep(ADVERSE_MEDIA_CONFIG.rateLimit);
    }

    // 3) Company registry — block-level re-run (once), LV company only.
    if (registryRows.length > 0) {
      if (scr.entity_type === "company" && isLatviaJurisdiction(scr.jurisdiction)) {
        try {
          page = await recyclePage(page, context);
          // Block-level: the registry re-runs as a whole 3-screenshot set, so
          // clear ALL existing registry rows for this screening (not just the
          // selected check_ids) before re-inserting — otherwise unselected
          // Detail/Persons rows would duplicate against the fresh block.
          const { data: allReg } = await supabase
            .from("screening_checks")
            .select("id, screenshot_path")
            .eq("screening_id", screeningId)
            .eq("category", "company_registry");
          const oldShots = (allReg ?? [])
            .map((r) => r.screenshot_path)
            .filter((p): p is string => !!p);
          if (oldShots.length) {
            await supabase.storage.from("evidence-screenshots").remove(oldShots).catch(() => {});
          }
          await supabase
            .from("screening_checks")
            .delete()
            .eq("screening_id", screeningId)
            .eq("category", "company_registry");
          await rerunCompanyRegistry(supabase, page, {
            screeningId, entityName: scr.entity_name, registrationNumber: scr.registration_number,
          });
          outcome.registry_block_rerun = true;
        } catch (err) {
          outcome.errors.push({ database_name: COMPANY_REGISTRY_CONFIG.name, message: formatErrorDetail(err) });
        }
      } else {
        for (const r of registryRows) {
          outcome.skipped.push({ check_id: r.id, database_name: r.database_name, reason: "registry re-run applies only to a Latvian company" });
        }
      }
    }
  } finally {
    if (browser) await browser.close();
  }
  return outcome;
}
