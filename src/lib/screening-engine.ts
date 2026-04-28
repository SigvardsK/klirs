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
import { expandLvVariants } from "./name-variants";
import type { Person } from "./types";

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
  const searchTerms = buildSearchTerms(job);
  const personVariantCount = searchTerms.persons.reduce(
    (sum, p) => sum + p.variants.length,
    0
  );
  const companyVariantCount = searchTerms.companyVariants.length;

  for (const db of SEARCHABLE_DATABASES) {
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

  // Company registry: 3 checks (search results + company detail + persons tab)
  if (job.entityType === "company") {
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
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 1024 },
      locale: "en-US",
    });

    let page = await context.newPage();
    const terms = buildSearchTerms(job);

    // 1. Searchable databases
    for (const db of SEARCHABLE_DATABASES) {
      const searchItems = getSearchItems(db, terms, job.entityType);

      for (const searchTerm of searchItems) {
        try {
          const result = await runDatabaseCheck(page, db, searchTerm);
          // Downgrade `hit` → `uncertain` for sources with known company-query
          // noise (e.g., UK Sanctions' tokenised multi-word search). Evidence is
          // preserved — screenshot, source URL, and search term all still insert —
          // we just refuse to claim the match is confirmed.
          if (
            db.downgradeCompanyHits &&
            job.entityType === "company" &&
            result.status === "hit"
          ) {
            result.status = "uncertain";
            result.reason =
              `${db.name} uses tokenised multi-word search across all fields, so any 'hit' on a multi-word company name may be a tokenisation artefact (e.g. 'Corporation' matches 137 records). Manually review the screenshot before treating as a confirmed match.`;
          }
          const screenshotPath = await uploadScreenshot(
            supabase,
            job.screeningId,
            page,
            db,
            searchTerm
          );

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
            details: err instanceof Error ? err.message : "Unknown error",
            source_url: safePageUrl(page),
            checked_at: new Date().toISOString(),
          });
        }

        checksCompleted++;
        await supabase
          .from("screenings")
          .update({ checks_completed: checksCompleted })
          .eq("id", job.screeningId);

        // Rate limiting
        await sleep(db.rateLimit);
      }
    }

    // Recycle the page between major sections to release per-page DOM/JS heap
    // accumulated across all the sanctions queries. Keeps the browser alive
    // (re-launching is expensive) but resets the heap pressure that caused a
    // company screening to die when UR's heavy SPA loaded on top of stacked
    // sanctions-source memory.
    page = await recyclePage(page, context);

    // 2. Adverse media checks (DuckDuckGo with playwright-extra stealth)
    // Fan out across every person variant (primary + aliases) in each language.
    const languages = ["LV", "EN", "ET", "RU"] as const;
    const personVariants: string[] = terms.persons.flatMap(p => p.variants);
    for (const personName of personVariants) {
      for (const lang of languages) {
        try {
          // Reset viewport to adverse-media default (1024) — previous db check
          // may have left a taller viewport (UK/UR at 1400).
          await page.setViewportSize({ width: 1280, height: ADVERSE_MEDIA_CONFIG.viewportHeight || 1024 });
          const template = ADVERSE_MEDIA_CONFIG.searchTemplates?.[lang] || "";
          const query = template.replace("{name}", personName);
          const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;

          await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          await sleep(ADVERSE_MEDIA_CONFIG.waitMs);

          // Validate page actually loaded search results (not error/CAPTCHA)
          let pageText = await page.textContent("body").catch(() => "");
          const isBlocked = !pageText || pageText.length < 200 ||
            pageText.includes("Unexpected error") ||
            pageText.includes("bots use DuckDuckGo") ||
            pageText.includes("Select all squares") ||
            pageText.includes("unusual traffic") ||
            pageText.includes("not a robot");

          // Retry once after 60s if blocked — DDG occasionally throws a CAPTCHA challenge
          if (isBlocked) {
            console.warn(`DDG blocked for ${personName} (${lang}), retrying in 60s...`);
            await sleep(60000);
            await page.reload({ waitUntil: "domcontentloaded" });
            await sleep(ADVERSE_MEDIA_CONFIG.waitMs);

            pageText = await page.textContent("body").catch(() => "");
            const stillBlocked = !pageText || pageText.length < 200 ||
              pageText.includes("Unexpected error") ||
              pageText.includes("bots use DuckDuckGo") ||
              pageText.includes("Select all squares");

            if (stillBlocked) {
              throw new Error("Search engine blocked automated access after retry");
            }
          }

          // Inject evidence header
          await injectEvidenceHeader(page, `Adverse Media (${lang})`, personName);

          const screenshotPath = await uploadScreenshot(
            supabase,
            job.screeningId,
            page,
            { ...ADVERSE_MEDIA_CONFIG, filenamePrefix: `adverse_media_${lang.toLowerCase()}` },
            personName
          );

          // Adverse media: classify via tri-state rather than defaulting to clear.
          // DDG's "No results" indicator → clear; otherwise → uncertain (human review of
          // the search results screenshot required). Defaulting to clear here is the
          // exact failure mode the load-bearing classifier contract exists to prevent.
          const adverseMediaResult = classifyResult(pageText || "", ADVERSE_MEDIA_CONFIG);
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
          // Take screenshot of error state for evidence
          const errorScreenshotPath = await uploadScreenshot(
            supabase,
            job.screeningId,
            page,
            { ...ADVERSE_MEDIA_CONFIG, filenamePrefix: `adverse_media_${lang.toLowerCase()}` },
            personName
          ).catch(() => null);

          await supabase.from("screening_checks").insert({
            screening_id: job.screeningId,
            database_name: `Adverse Media (${lang})`,
            category: "adverse_media",
            search_term: `${personName} (${lang})`,
            status: "error",
            details: err instanceof Error ? err.message : "Unknown error",
            screenshot_path: errorScreenshotPath,
            source_url: safePageUrl(page),
            checked_at: new Date().toISOString(),
          });
        }

        checksCompleted++;
        await supabase
          .from("screenings")
          .update({ checks_completed: checksCompleted })
          .eq("id", job.screeningId);

        await sleep(ADVERSE_MEDIA_CONFIG.rateLimit);
      }
    }

    // Recycle again before the heaviest section. UR's SPA pulls many tracker
    // scripts; landing on it with a stale heap was the proximate cause of the
    // 3-day company-screening stall.
    if (job.entityType === "company") {
      page = await recyclePage(page, context);
    }

    // 3. Company registry (SPA — 3 screenshots: search results + company detail + persons tab)
    if (job.entityType === "company") {
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
          details: err instanceof Error ? err.message : "Unknown error",
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
  db: Pick<DbConfig, "noResultsIndicator" | "hitIndicator" | "hitIndicatorPattern">
): CheckResult {
  const text = pageText.toLowerCase();
  const excerpt = pageText.slice(0, PAGE_TEXT_EXCERPT_CHARS);
  if (db.noResultsIndicator && text.includes(db.noResultsIndicator.toLowerCase())) {
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
    await page.goto(db.url, { waitUntil: "domcontentloaded", timeout: 30000 });
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

    // Classify with tri-state precedence
    const pageText = (await page.textContent("body").catch(() => "")) || "";
    return classifyResult(pageText, db);

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
