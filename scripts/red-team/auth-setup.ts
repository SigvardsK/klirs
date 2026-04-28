/**
 * Red-team auth-setup — opens a headed browser, user completes Google OAuth
 * manually (including 2FA), then persists the session cookies to
 * scripts/red-team/auth.json. Subsequent red-team:run invocations use that
 * file to skip login.
 *
 * Run ONCE per session (Supabase sessions expire ~1h):
 *   BASE_URL=https://your-deployment.example.com npm run red-team:auth
 *
 * Target user: a SUPERUSER account (configured via SUPERUSER_EMAILS) so
 * the harness can bypass the freemium gate and submit non-demo screenings.
 */

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

chromium.use(StealthPlugin());

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_PATH = resolve(HERE, "auth.json");
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

async function main() {
  mkdirSync(HERE, { recursive: true });

  console.log(`Opening ${BASE_URL}/login in a headed browser...`);
  console.log(`Sign in with a SUPERUSER account, then the script will save the session.`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${BASE_URL}/login`);

  console.log("Waiting for redirect to /dashboard (complete the Google sign-in)...");
  await page.waitForURL(/\/dashboard/, { timeout: 180_000 });

  console.log("Signed in. Persisting auth state...");
  await context.storageState({ path: AUTH_PATH });

  console.log(`✓ Auth state saved to ${AUTH_PATH}`);
  console.log(`Supabase sessions expire in ~1h; re-run this script if red-team:run fails with Unauthorized.`);

  await browser.close();
}

main().catch(err => { console.error(err); process.exit(1); });
