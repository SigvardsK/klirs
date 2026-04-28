/**
 * Red-team capture helpers — screenshot, timing, and state-probe utilities.
 */

import type { Page } from "playwright";
import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Timings {
  t_open_form?: number;
  t_form_filled?: number;
  t_submit?: number;
  t_landed_on_results?: number;
  t_first_check_visible?: number;
  t_completed?: number;
  submit_to_completed_ms?: number;
  submit_to_first_check_ms?: number;
}

export interface CheckSummary {
  id: string;
  database_name: string;
  category: string;
  search_term: string;
  status: string;
  screenshot_path: string | null;
  source_url: string | null;
  checked_at: string | null;
}

export async function screenshot(
  page: Page,
  caseDir: string,
  name: string
): Promise<string> {
  const path = resolve(caseDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true });
  return path;
}

export async function waitForCompletion(
  page: Page,
  screeningId: string,
  baseUrl: string,
  timings: Timings,
  opts: { timeoutMs?: number } = {}
): Promise<CheckSummary[]> {
  const started = Date.now();
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
  let firstSeen = false;

  while (Date.now() - started < timeout) {
    const [statusRes, checksRes] = await Promise.all([
      page.request.get(`${baseUrl}/api/screenings/${screeningId}/status`),
      page.request.get(`${baseUrl}/api/screenings/${screeningId}/checks`),
    ]);

    if (!statusRes.ok() || !checksRes.ok()) {
      await page.waitForTimeout(3000);
      continue;
    }

    const status = await statusRes.json();
    const checks = (await checksRes.json()) as CheckSummary[];

    if (!firstSeen && checks.length > 0) {
      firstSeen = true;
      timings.t_first_check_visible = Date.now();
      if (timings.t_submit) {
        timings.submit_to_first_check_ms = timings.t_first_check_visible - timings.t_submit;
      }
    }

    if (status.status === "completed") {
      timings.t_completed = Date.now();
      if (timings.t_submit) {
        timings.submit_to_completed_ms = timings.t_completed - timings.t_submit;
      }
      return checks;
    }
    if (status.status === "failed") {
      throw new Error(`Screening ${screeningId} failed.`);
    }

    await page.waitForTimeout(5000);
  }

  throw new Error(`Screening ${screeningId} did not complete within ${timeout}ms.`);
}

export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}
