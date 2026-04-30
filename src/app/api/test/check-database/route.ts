/**
 * Diagnostic endpoint to test individual database checks from Railway.
 * Launches stealth browser, visits database, takes screenshot, returns results.
 *
 * GET /api/test/check-database?db=adverse_media&term=Test+Name&lang=EN
 * GET /api/test/check-database?db=ur_registry&term=SIA+SK+Funding
 * GET /api/test/check-database?db=firmas_sanctions&term=SIA+SK+Funding
 */

import { NextResponse } from "next/server";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { createClient } from "@supabase/supabase-js";
import { SEARCHABLE_DATABASES, ADVERSE_MEDIA_CONFIG, COMPANY_REGISTRY_CONFIG } from "@/lib/db-configs";
import { classifyResult, fillSearchWithRetry } from "@/lib/screening-engine";
import type { CheckStatus } from "@/lib/types";

chromium.use(StealthPlugin());

function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const dbId = searchParams.get("db") || "adverse_media";
  const searchTerm = searchParams.get("term") || "Test Company";
  const lang = searchParams.get("lang") || "EN";

  const startTime = Date.now();
  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 1024 },
      locale: "en-US",
    });

    const page = await context.newPage();

    // Apply per-source viewport height so this diagnostic captures the same
    // framing as the real engine (UK Sanctions / UR Registry use 1400).
    const dbForViewport = SEARCHABLE_DATABASES.find(d => d.id === dbId) ||
      (dbId === "ur_registry" ? COMPANY_REGISTRY_CONFIG :
       dbId === "adverse_media" ? ADVERSE_MEDIA_CONFIG : null);
    await page.setViewportSize({ width: 1280, height: dbForViewport?.viewportHeight || 1024 });

    let screenshotUrl: string | null = null;
    let pageTextLength = 0;
    let isBlocked = false;
    let pageUrl = "";
    let debugSnippet = "";
    let resolvedStatus: CheckStatus | null = null;
    let resolvedReason: string | null = null;

    if (dbId === "adverse_media") {
      // DuckDuckGo adverse media search
      const template = ADVERSE_MEDIA_CONFIG.searchTemplates?.[lang] || '"{name}" crime OR fraud';
      const query = template.replace("{name}", searchTerm);
      const url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));

      const pageText = await page.textContent("body").catch(() => "");
      pageTextLength = pageText?.length || 0;
      pageUrl = page.url();
      debugSnippet = (pageText || "").slice(0, 500);

      isBlocked = !pageText || pageText.length < 200 ||
        pageText.includes("Unexpected error") ||
        pageText.includes("bots use DuckDuckGo") ||
        pageText.includes("Select all squares") ||
        pageText.includes("unusual traffic") ||
        pageText.includes("not a robot");

      if (!isBlocked) {
        const cls = classifyResult(pageText || "", ADVERSE_MEDIA_CONFIG, searchTerm);
        resolvedStatus = cls.status;
        resolvedReason = cls.reason ?? null;
      }

    } else if (dbId === "ur_registry") {
      // Company registry SPA — verbose debug to diagnose Railway failure
      const steps: string[] = [];

      steps.push("1. goto networkidle...");
      await page.goto(COMPANY_REGISTRY_CONFIG.url, { waitUntil: "networkidle", timeout: 30000 });
      steps.push("1. done");

      // Check what inputs exist BEFORE cookie dismiss
      const inputsBefore = await page.evaluate(() => {
        const inputs = document.querySelectorAll("input");
        return Array.from(inputs).map(i => ({
          placeholder: i.placeholder,
          type: i.type,
          visible: i.offsetHeight > 0,
          id: i.id,
          class: i.className,
        }));
      });
      steps.push(`2. inputs before cookie: ${JSON.stringify(inputsBefore)}`);

      // Dismiss cookies
      try {
        const cookieBtn = page.locator('button:has-text("Aizvērt")').first();
        const cookieVisible = await cookieBtn.isVisible({ timeout: 3000 });
        steps.push(`3. cookie btn visible: ${cookieVisible}`);
        if (cookieVisible) {
          await cookieBtn.click();
          await new Promise(r => setTimeout(r, 1000));
          steps.push("3. cookie clicked");
        }
      } catch (e) {
        steps.push(`3. cookie error: ${e}`);
      }

      // Check inputs AFTER cookie dismiss
      const inputsAfter = await page.evaluate(() => {
        const inputs = document.querySelectorAll("input");
        return Array.from(inputs).map(i => ({
          placeholder: i.placeholder,
          type: i.type,
          visible: i.offsetHeight > 0,
        }));
      });
      steps.push(`4. inputs after cookie: ${JSON.stringify(inputsAfter)}`);

      // Try to find and fill the search input
      try {
        const found = await page.waitForFunction(() => {
          const input = document.querySelector('input[placeholder*="Uzņēmuma nosaukums"]');
          return input && (input as HTMLElement).offsetHeight > 0;
        }, { timeout: 15000 });
        steps.push(`5. waitForFunction passed: ${!!found}`);

        const searchInput = page.locator('input[placeholder*="Uzņēmuma nosaukums"]').first();
        const box = await searchInput.boundingBox();
        steps.push(`6. boundingBox: ${JSON.stringify(box)}`);

        await searchInput.click();
        steps.push("7. clicked");
        await new Promise(r => setTimeout(r, 300));

        // Use evaluate to set value AND dispatch React-compatible events
        await page.evaluate((term) => {
          const input = document.querySelector('input.DataSearch-input') as HTMLInputElement;
          if (!input) return;
          // Set value via native setter to trigger React's synthetic event system
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set;
          nativeInputValueSetter?.call(input, term);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, searchTerm);
        steps.push("8. set value via native setter + dispatched input/change events");

        const inputValue = await searchInput.inputValue();
        steps.push(`9. inputValue: "${inputValue}"`);

        await new Promise(r => setTimeout(r, 1000));

        // Press Enter to submit
        await searchInput.press("Enter");
        steps.push("10. Enter pressed on input");

        await new Promise(r => setTimeout(r, 5000));

        const pageTextAfter = await page.textContent("body").catch(() => "");
        steps.push(`11. pageTextLength after search: ${pageTextAfter?.length}`);

        // Inspect search result elements to understand DOM structure
        // Click first result to show company detail page
        if ((pageTextAfter?.length || 0) >= 2000) {
          try {
            const firstResult = page.locator('a.Anchor[href*="/legal-entity/"]').first();
            if (await firstResult.isVisible({ timeout: 3000 })) {
              const resultText = await firstResult.textContent();
              await firstResult.click();
              await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 5000)); // Wait for SPA detail page to fully render
              steps.push(`12. clicked result: "${resultText}"`);
              steps.push(`13. detail pageUrl: ${page.url()}`);
              const detailText = await page.textContent("body").catch(() => "");
              steps.push(`14. detail pageTextLength: ${detailText?.length}`);
            } else {
              steps.push("12. no a.Anchor[href*=/legal-entity/] found");
            }
          } catch (e) {
            steps.push(`12. click error: ${e}`);
          }
        }
      } catch (e) {
        steps.push(`ERROR: ${e}`);
      }

      const pageText = await page.textContent("body").catch(() => "");
      pageTextLength = pageText?.length || 0;
      pageUrl = page.url();
      debugSnippet = steps.join("\n");

    } else {
      // Searchable database
      const db = SEARCHABLE_DATABASES.find(d => d.id === dbId);
      if (!db) {
        return NextResponse.json({ error: `Database '${dbId}' not found` }, { status: 400 });
      }

      await page.goto(db.url, { waitUntil: "domcontentloaded", timeout: 15000 });
      await new Promise(r => setTimeout(r, 1000));

      // Inspect bottom-of-page elements for cookie banner debugging
      if (dbId === "firmas_sanctions") {
        const bottomElements = await page.evaluate(() => {
          const results: Array<{tag: string; class: string; position: string; bottom: number; height: number; text: string}> = [];
          document.querySelectorAll('*').forEach(el => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            if (rect.bottom >= window.innerHeight - 50 && rect.height > 20 && rect.height < 200) {
              results.push({
                tag: el.tagName,
                class: el.className?.toString().slice(0, 60) || '',
                position: style.position,
                bottom: Math.round(rect.bottom),
                height: Math.round(rect.height),
                text: (el as HTMLElement).innerText?.slice(0, 40) || '',
              });
            }
          });
          return results.slice(0, 10);
        });
        debugSnippet = `Bottom elements: ${JSON.stringify(bottomElements, null, 1)}`;
      }

      // Dismiss cookies using full dismissCookies logic
      // Step 1: try common selectors
      const cookieSelectors = [
        'button:has-text("Reject")', 'button:has-text("Noraidīt")',
        'button:has-text("Accept")', 'button:has-text("Piekrītu")',
        'button:has-text("OK")', '.cookie-reject-all',
      ];
      for (const sel of cookieSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.isVisible({ timeout: 500 })) {
            await btn.click({ timeout: 1000 });
            await new Promise(r => setTimeout(r, 300));
            break;
          }
        } catch {}
      }
      // Step 2: DOM removal (text-based + class-based + fixed-bottom catch-all)
      await page.evaluate(() => {
        // Text-based: remove elements mentioning cookies in Latvian/English
        const cookieTextIndicators = ['sīkdatne', 'sīkdatņ', 'sikdat', 'cookie'];
        document.querySelectorAll('div, section, aside, footer').forEach(el => {
          const text = (el as HTMLElement).innerText?.toLowerCase() || '';
          if (text.length < 500 && cookieTextIndicators.some(ind => text.includes(ind))) {
            const rect = el.getBoundingClientRect();
            if (rect.height < 200) el.remove();
          }
        });
        // Class-based
        ['[class*="cookie"]', '[id*="cookie"]', '[class*="consent"]', '[class*="sikdat"]'].forEach(sel => {
          document.querySelectorAll(sel).forEach(el => el.remove());
        });
        // Fixed bottom catch-all
        document.querySelectorAll('*').forEach(el => {
          if (el.id === 'aml-evidence-header') return;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if ((style.position === 'fixed' || style.position === 'sticky') &&
              rect.bottom >= window.innerHeight - 10 && rect.height < 200) {
            el.remove();
          }
        });
      }).catch(() => {});

      // Fill and submit — use the engine's retry helper so this diagnostic
      // has the same fill semantics as a real screening. Engine-parity is
      // load-bearing: the smoke test relies on it for its assertions.
      if (db.searchSelector) {
        await fillSearchWithRetry(page, db, searchTerm);
        if (db.submitSelector) {
          await page.click(db.submitSelector);
        } else {
          await page.keyboard.press("Enter");
        }
        await new Promise(r => setTimeout(r, db.waitMs));
      }

      const pageText = await page.textContent("body").catch(() => "");
      pageTextLength = pageText?.length || 0;
      pageUrl = page.url();
      if (!debugSnippet) debugSnippet = (pageText || "").slice(0, 500);

      isBlocked = pageText?.includes("Verify you are human") || false;

      // Classify using the same tri-state logic as the engine.
      const cls = classifyResult(pageText || "", db, searchTerm);
      resolvedStatus = cls.status;
      resolvedReason = cls.reason ?? null;
    }

    // Inject evidence header at bottom of page (same as screening engine)
    try {
      const timestamp = new Date().toISOString();
      const headerDbName = dbId === "adverse_media" ? `Adverse Media (${lang})` :
        dbId === "ur_registry" ? "Company Registry (Latvia)" :
        SEARCHABLE_DATABASES.find(d => d.id === dbId)?.name || dbId;
      await page.evaluate(({ dbName, searchTerm, timestamp }) => {
        // Remove any fixed-bottom elements first (cookie banners)
        document.querySelectorAll('*').forEach(el => {
          if (el.id === 'aml-evidence-header') return;
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          if ((style.position === 'fixed' || style.position === 'sticky') &&
              rect.bottom >= window.innerHeight - 10 && rect.height < 200) {
            el.remove();
          }
        });
        // Also remove by cookie text
        ['sīkdatne', 'sīkdatņ', 'sikdat', 'cookie'].forEach(word => {
          document.querySelectorAll('div, section, aside').forEach(el => {
            const text = (el as HTMLElement).innerText?.toLowerCase() || '';
            if (text.length < 500 && text.includes(word)) {
              const rect = el.getBoundingClientRect();
              if (rect.height < 200) el.remove();
            }
          });
        });
        // Inject header
        const existing = document.getElementById("aml-evidence-header");
        if (existing) existing.remove();
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
      }, { dbName: headerDbName, searchTerm, timestamp });
    } catch { /* non-critical */ }

    // Viewport-only screenshot — height is controlled by the per-db viewport
    // override set before interaction (see resolveViewport call above). Mirrors
    // the engine's uploadScreenshot() semantics so this diagnostic captures the
    // same framing as a real screening run.
    const screenshotBuffer = await page.screenshot({ fullPage: false });
    const supabase = getAdminClient();
    const filename = `test/${dbId}/${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage
      .from("evidence-screenshots")
      .upload(filename, screenshotBuffer, { contentType: "image/png", upsert: true });

    if (!uploadError) {
      screenshotUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/evidence-screenshots/${filename}`;
    }

    await browser.close();
    browser = null;

    return NextResponse.json({
      success: !isBlocked,
      dbId,
      searchTerm,
      lang: dbId === "adverse_media" ? lang : undefined,
      // Tri-state classification (clear | hit | uncertain) matching the engine. Smoke tests
      // assert on this: a known-sanctioned term returning "clear" is a regression.
      status: resolvedStatus,
      statusReason: resolvedReason,
      screenshotUrl,
      pageUrl,
      pageTextLength,
      isBlocked,
      debugSnippet,
      elapsedMs: Date.now() - startTime,
    });

  } catch (err) {
    return NextResponse.json({
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
      elapsedMs: Date.now() - startTime,
    }, { status: 500 });
  } finally {
    if (browser) await browser.close();
  }
}
