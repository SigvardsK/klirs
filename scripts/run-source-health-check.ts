/**
 * Daily source-health canary.
 *
 * For every entry in SEARCHABLE_DATABASES with a `healthCheck` block, runs the
 * deployed `/api/test/check-database` endpoint twice — once with the known-clean
 * term, once with the known-sanctioned term — and asserts that the engine's
 * tri-state classifier produces the contracted outcome on each.
 *
 * Wired to .github/workflows/source-health-check.yml (daily 06:00 UTC). A non-
 * zero exit fails the workflow and surfaces in the GitHub Actions tab — the
 * public, buyer-facing answer to "how do you know the tool doesn't silently
 * break if a target page changes."
 *
 * Usage:
 *   BASE_URL=https://klirs.eu npx tsx scripts/run-source-health-check.ts
 *
 * Exit 0 = every contracted source returned its expected status on both terms.
 * Exit 1 = at least one source regressed (silent false-clear, missed hit, etc).
 * Exit 2 = infrastructure error (endpoint unreachable, all checks blocked).
 */

import { SEARCHABLE_DATABASES } from "../src/lib/db-configs";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ENDPOINT = `${BASE_URL}/api/test/check-database`;
const FETCH_TIMEOUT_MS = 120_000;

interface CheckResult {
  source: string;
  sourceName: string;
  checkType: "clean" | "sanctioned";
  term: string;
  expected: string;
  observed: string | null;
  isRegression: boolean;
  isInfraError: boolean;
  detail?: string;
  latencyMs: number;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runOne(
  source: string,
  sourceName: string,
  checkType: "clean" | "sanctioned",
  term: string,
  expected: string
): Promise<CheckResult> {
  const url = `${ENDPOINT}?db=${encodeURIComponent(source)}&term=${encodeURIComponent(term)}`;
  const started = Date.now();
  try {
    const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        source,
        sourceName,
        checkType,
        term,
        expected,
        observed: null,
        isRegression: false,
        isInfraError: true,
        detail: `HTTP ${res.status}`,
        latencyMs,
      };
    }
    const body = (await res.json()) as {
      status?: string | null;
      isBlocked?: boolean;
      error?: string;
      statusReason?: string | null;
    };
    if (body.error) {
      return {
        source,
        sourceName,
        checkType,
        term,
        expected,
        observed: null,
        isRegression: false,
        isInfraError: true,
        detail: body.error,
        latencyMs,
      };
    }
    if (body.isBlocked) {
      return {
        source,
        sourceName,
        checkType,
        term,
        expected,
        observed: "blocked",
        isRegression: false,
        isInfraError: true,
        detail: "Source returned bot-protection page",
        latencyMs,
      };
    }
    const observed = body.status ?? null;
    return {
      source,
      sourceName,
      checkType,
      term,
      expected,
      observed,
      isRegression: observed !== expected,
      isInfraError: false,
      detail: body.statusReason ?? undefined,
      latencyMs,
    };
  } catch (err) {
    return {
      source,
      sourceName,
      checkType,
      term,
      expected,
      observed: null,
      isRegression: false,
      isInfraError: true,
      detail: err instanceof Error ? err.message : String(err),
      latencyMs: Date.now() - started,
    };
  }
}

function format(r: CheckResult): string {
  const verdict = r.isRegression
    ? "REGRESSION"
    : r.isInfraError
      ? "INFRA_ERROR"
      : "ok";
  const detail = r.detail ? ` — ${r.detail}` : "";
  return `[${verdict}] ${r.source} / ${r.checkType} / "${r.term}" → expected=${r.expected} observed=${r.observed ?? "null"} (${r.latencyMs}ms)${detail}`;
}

async function main() {
  console.log(`[source-health-check] BASE_URL=${BASE_URL}`);
  console.log(`[source-health-check] endpoint=${ENDPOINT}`);
  const sources = SEARCHABLE_DATABASES.filter(db => db.healthCheck);
  console.log(`[source-health-check] sources with healthCheck contracts: ${sources.length}`);

  const results: CheckResult[] = [];
  for (const db of sources) {
    const hc = db.healthCheck!;
    console.log(`\n--- ${db.id} (${db.name}) ---`);
    const cleanRes = await runOne(db.id, db.name, "clean", hc.knownCleanTerm, hc.expectedCleanStatus);
    console.log(format(cleanRes));
    results.push(cleanRes);

    const sanctionedRes = await runOne(db.id, db.name, "sanctioned", hc.knownSanctionedTerm, hc.expectedSanctionedStatus);
    console.log(format(sanctionedRes));
    results.push(sanctionedRes);
  }

  const regressions = results.filter(r => r.isRegression);
  const infraErrors = results.filter(r => r.isInfraError);

  console.log("\n=== summary ===");
  console.log(`total checks: ${results.length}`);
  console.log(`regressions: ${regressions.length}`);
  console.log(`infra errors: ${infraErrors.length}`);

  // Emit a JSON line for downstream consumers (GitHub Actions step output, log-aggregators, etc).
  const summary = {
    baseUrl: BASE_URL,
    timestamp: new Date().toISOString(),
    totalChecks: results.length,
    regressionCount: regressions.length,
    infraErrorCount: infraErrors.length,
    regressions: regressions.map(r => ({
      source: r.source,
      checkType: r.checkType,
      term: r.term,
      expected: r.expected,
      observed: r.observed,
      detail: r.detail,
    })),
    infraErrors: infraErrors.map(r => ({
      source: r.source,
      checkType: r.checkType,
      term: r.term,
      detail: r.detail,
    })),
  };
  console.log("\n::SUMMARY_JSON::");
  console.log(JSON.stringify(summary));

  if (regressions.length > 0) {
    console.error(`\n[source-health-check] ${regressions.length} regression(s) detected — failing.`);
    process.exit(1);
  }
  // Per-source infra errors fail the workflow too: a single source returning a
  // bot-protection page or being unreachable is exactly what the buyer-facing
  // canary is supposed to surface. The original "fail only on full outage"
  // logic let single-source blocks pass silently — the README's "Actions tab
  // is the public answer" claim weakens if one source can stay broken
  // indefinitely with green checks.
  if (infraErrors.length > 0) {
    console.error(`\n[source-health-check] ${infraErrors.length} infra error(s) — failing.`);
    if (infraErrors.length === results.length) {
      console.error(`[source-health-check] note: every check failed — deployment may be down.`);
      process.exit(2);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch(err => {
  console.error("[source-health-check] fatal", err);
  process.exit(2);
});
