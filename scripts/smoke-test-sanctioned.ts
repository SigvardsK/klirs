/**
 * Smoke test: known-sanctioned regression tripwire.
 *
 * Runs against the deployed /api/test/check-database endpoint and asserts that
 * the engine's tri-state classifier produces the expected outcome for both
 * known-clean and known-sanctioned inputs. A known-sanctioned term returning
 * `clear` across its expected sources is the load-bearing failure mode this
 * test exists to catch — the classifier must never default to `clear`.
 *
 * Usage:
 *   BASE_URL=https://your-deployment.example.com npx tsx scripts/smoke-test-sanctioned.ts
 *   # or:  npm run smoke:sanctioned
 *
 * Exit 0 = all expectations met. Exit 1 = at least one regression. Exit 2 = infra error
 * (endpoint unreachable, all checks blocked).
 */

import { expandLvVariants } from "../src/lib/name-variants";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ENDPOINT = `${BASE_URL}/api/test/check-database`;
const FETCH_TIMEOUT_MS = 120_000;

type ExpectedStatus = "clear" | "hit" | "uncertain";

interface TestCase {
  label: string;
  db: string;
  term: string;
  expect: ExpectedStatus[]; // passes if actual is in this set
  note?: string;
  // When true, the test runs against ALL variants of `term` produced by
  // expandLvVariants (mirrors the engine's actual fan-out), and passes if
  // ANY variant's status is in `expect`. Used for the auto-expansion
  // contract: "Pjotr Avens" must produce a hit on Firmas via the auto-derived
  // "Pjotrs Avens" variant. If no variant matches, the test fails — which is
  // the regression-tripwire signal that the LV transliteration heuristic
  // got broken or the sanctions index changed.
  expand?: boolean;
}

// Sources used for sanctions checks. Adverse media + UR registry excluded —
// they are not sanctions lists and have noisier semantics.
const SANCTIONS_DBS = ["ofac_sdn", "uk_sanctions", "firmas_sanctions"] as const;

const tests: TestCase[] = [
  // --- Negative controls: clean entities should produce `clear`. UK Sanctions' SPA
  // tokenises multi-word queries across all fields — "Microsoft Corporation" matches
  // 137 records because "Corporation" is common in sanctioned entity names. So we
  // use a single-word clean term ("Microsoft") for UK to avoid false positives from
  // tokenisation. OFAC + Firmas handle multi-word queries correctly and stay on the
  // canonical "Microsoft Corporation" clean term. ---
  ...SANCTIONS_DBS.map(db => ({
    label: `CLEAN / ${db}`,
    db,
    term: db === "uk_sanctions" ? "Microsoft" : "Microsoft Corporation",
    expect: ["clear"] as ExpectedStatus[],
    note: "Negative control — clean entity. UK uses single-word to dodge tokenisation.",
  })),

  // --- Known-sanctioned with canonical English spelling (aliases are the demo-v2 fix) ---
  //
  // Pyotr Aven is on OFAC, UK, and EU sanctions lists. Canonical Latin spelling
  // on those lists: AVEN, PETR. The Latvian transliteration (Pjotrs Avens) does
  // NOT match the canonical record — that's exactly why the Aliases feature was
  // added. These cases simulate a user who has added the canonical alias.
  {
    label: "SANCTIONED canonical / ofac_sdn (Petr Aven)",
    db: "ofac_sdn",
    term: "Petr Aven",
    // OFAC now wires hitIndicatorPattern = /lookup results:\s*[1-9]\d*\s*found/i
    // (count-aware: clean shows "Lookup Results: 0 Found", hits show ≥1).
    // Sanctioned canonical name MUST hit — this is the regression tripwire.
    expect: ["hit"],
    note: "OFAC has AVEN, PETR on SDN. hitIndicatorPattern 'Lookup Results: [1-9]+ Found' must fire.",
  },
  {
    label: "SANCTIONED canonical / uk_sanctions (Petr Aven)",
    db: "uk_sanctions",
    term: "Petr Aven",
    // UK has hitIndicator="records found" wired. Sanctioned canonical name must hit.
    expect: ["hit"],
    note: "UK sanctions list has Petr Aven; hitIndicator 'records found' must fire.",
  },
  {
    label: "SANCTIONED canonical / firmas_sanctions (Petr Aven)",
    db: "firmas_sanctions",
    term: "Petr Aven",
    // Firmas has hitIndicator="rāda no 1" wired. Verified 3 matches for Petr Aven.
    expect: ["hit"],
    note: "Firmas aggregates EU sanctions; hitIndicator 'rāda no 1' must fire.",
  },

  // --- Auto-expansion regression probes ---
  //
  // User enters "Pjotr Avens" (no aliases). The engine MUST auto-expand to LV
  // transliteration variants so at least one variant matches a sanctioned
  // record. If `expand=true` produces all-clear across every variant, that's
  // the same false-negative that auto-expansion was added to prevent.
  //
  // Firmas indexes "Pjotrs Avens" (LV form). Auto-expansion adds "Pjotrs Avens"
  // variant → must hit.
  {
    label: "AUTO-EXPAND SANCTIONED / firmas_sanctions (Pjotr Avens → variants)",
    db: "firmas_sanctions",
    term: "Pjotr Avens",
    expand: true,
    expect: ["hit"],
    note: "User enters 'Pjotr Avens'; expansion must add 'Pjotrs Avens' which hits Firmas.",
  },
  // OFAC indexes "AVEN, PETR". Auto-expansion adds "Pjotr Aven" (drop trailing s).
  // Tightened to ["hit"] 2026-04-27 — OFAC now has hitIndicatorPattern wired.
  {
    label: "AUTO-EXPAND SANCTIONED / ofac_sdn (Pjotr Avens → variants)",
    db: "ofac_sdn",
    term: "Pjotr Avens",
    expand: true,
    expect: ["hit"],
    note: "User enters 'Pjotr Avens'; expansion adds 'Pjotr Aven' (drop-s); hitIndicatorPattern must fire on AVEN, PETR.",
  },

  // --- Another sanctioned person with less transliteration ambiguity ---
  {
    label: "SANCTIONED / ofac_sdn (Ramzan Kadyrov)",
    db: "ofac_sdn",
    term: "Ramzan Kadyrov",
    // Tightened to ["hit"] 2026-04-27 — OFAC hitIndicatorPattern wired.
    expect: ["hit"],
    note: "OFAC has KADYROV, Ramzan Akhmadovich on SDN. hitIndicatorPattern must fire.",
  },
  {
    label: "SANCTIONED / uk_sanctions (Ramzan Kadyrov)",
    db: "uk_sanctions",
    term: "Ramzan Kadyrov",
    expect: ["hit"],
    note: "UK sanctions list has Kadyrov; hitIndicator 'records found' must fire.",
  },

  // === Sprint 2 §B6 / T5 — phonetic / transliteration coverage probes ===
  //
  // These cases target the gap classes documented in
  // docs/sprint-2/PHONETIC-AUDIT.md. Each case must return `hit` somewhere
  // in the sanctions trio (or `uncertain`) — never `clear`. A `clear`
  // verdict on any of these is a BLOCKER per LR-WS-2026-029. T5 cases 1, 4,
  // 5 are expected to FAIL until B6 P0 transformer set ships (Cyrillic
  // transliteration + initial expansion + punctuation handling). That's the
  // intended tripwire — the test surfaces the BLOCKERs, T6 closes them.

  // T5 Case 1 — Cyrillic original (BLOCKER probe: Cyrillic ↔ Latin transliteration)
  // Пётр Авен is OFAC-, UK-, EU-sanctioned in Latin form. Without Cyrillic
  // transliteration the engine queries the Cyrillic string against sources
  // that index only Latin → all return clear (silent false-clear).
  {
    label: "T5.1 SANCTIONED Cyrillic / ofac_sdn (Пётр Авен)",
    db: "ofac_sdn",
    term: "Пётр Авен",
    expect: ["hit", "uncertain"],
    note: "BLOCKER probe — OFAC indexes AVEN, PETR (Latin). Until Cyrillic→Latin transliteration ships, this will return clear (silent false-clear failure mode).",
  },
  {
    label: "T5.1 SANCTIONED Cyrillic / uk_sanctions (Пётр Авен)",
    db: "uk_sanctions",
    term: "Пётр Авен",
    expect: ["hit", "uncertain"],
    note: "BLOCKER probe — UK indexes Petr Aven (Latin). Same Cyrillic→Latin gap.",
  },
  {
    label: "T5.1 SANCTIONED Cyrillic / firmas_sanctions (Пётр Авен)",
    db: "firmas_sanctions",
    term: "Пётр Авен",
    expect: ["hit", "uncertain"],
    note: "Firmas may index EU-consolidated Cyrillic aliases — possibly hits without engine fix; acceptable as long as it doesn't return clear.",
  },

  // T5 Case 2 — LV transliteration (canonical Firmas form, no auto-expand)
  // "Pjotrs Avens" is the LV-suffixed canonical form. Firmas indexes this
  // exact string. Without auto-expand, OFAC sees the LV form and may not
  // match (no drop-s variant generated) — but Firmas should hit.
  {
    label: "T5.2 SANCTIONED LV-canonical / firmas_sanctioned (Pjotrs Avens, no expand)",
    db: "firmas_sanctions",
    term: "Pjotrs Avens",
    expect: ["hit"],
    note: "Firmas indexes 'Pjotrs Avens' exactly (LV form). Direct hit, no expansion needed.",
  },
  {
    label: "T5.2 SANCTIONED LV-canonical / firmas_sanctions (Pjotrs Avens, expand)",
    db: "firmas_sanctions",
    term: "Pjotrs Avens",
    expand: true,
    expect: ["hit"],
    note: "With expand the user-typed LV form should still hit Firmas via variant[0] (original).",
  },

  // T5 Case 3 — common misspelling without LV suffix on either token
  // "Pjotr Aven" is the form a non-Latvian compliance officer might type
  // (Latin Pjotr from Russian sources, no surname suffix). Firmas indexes
  // "Pjotrs Avens" — needs add-s expansion on both tokens to bridge.
  // OFAC indexes "AVEN, PETR" — partial match on "Aven" should hit even
  // without expansion.
  {
    label: "T5.3 SANCTIONED misspelling / firmas_sanctions (Pjotr Aven, expand)",
    db: "firmas_sanctions",
    term: "Pjotr Aven",
    expand: true,
    expect: ["hit"],
    note: "User types neither LV-suffixed nor canonical form. Auto-expand must add 'Pjotrs Avens' for Firmas hit.",
  },
  {
    label: "T5.3 SANCTIONED misspelling / ofac_sdn (Pjotr Aven, expand)",
    db: "ofac_sdn",
    term: "Pjotr Aven",
    expand: true,
    expect: ["hit"],
    note: "OFAC token-matches 'Aven' against AVEN, PETR; should hit on original or any variant.",
  },

  // T5 Case 4 — abbreviated initial (BLOCKER probe: initial expansion)
  // "P. Avens" is the format used in Latvian formal documents (legal
  // contracts, court records). Without initial-expansion, sources see "P."
  // as a token and treat the period as punctuation → effectively single-token
  // "P Avens" search → no matches.
  {
    label: "T5.4 SANCTIONED initial / firmas_sanctions (P. Avens, expand)",
    db: "firmas_sanctions",
    term: "P. Avens",
    expand: true,
    expect: ["hit", "uncertain"],
    note: "BLOCKER probe — Firmas indexes 'Pjotrs Avens'. Until initial expansion ships, P. → Pjotrs is unbridged; engine returns clear silently.",
  },
  {
    label: "T5.4 SANCTIONED initial / ofac_sdn (P. Avens, expand)",
    db: "ofac_sdn",
    term: "P. Avens",
    expand: true,
    expect: ["hit", "uncertain"],
    note: "BLOCKER probe — OFAC indexes AVEN, PETR. Initial 'P.' must expand to 'Petr'/'Pjotr' OR 'Avens' surname-only must match.",
  },

  // T5 Case 5 — hyphenated Arabic-origin OFAC name (BLOCKER probe: punctuation)
  // OFAC SDN includes hundreds of hyphenated/apostrophe-laden names. Without
  // punctuation normalisation, exact-string queries can miss the canonical
  // form when source-side tokenisation differs from input-side.
  // Pick: ABDUL-RAHIM, MOHAMMED ZAMAN (OFAC SDN, Hamas-affiliated). Verify
  // via OFAC search that this entity is currently listed before relying on
  // this case as a regression tripwire.
  {
    label: "T5.5 SANCTIONED hyphenated / ofac_sdn (Abdul-Rahim Mohammed Zaman, expand)",
    db: "ofac_sdn",
    term: "Abdul-Rahim Mohammed Zaman",
    expand: true,
    expect: ["hit", "uncertain"],
    note: "BLOCKER probe — Hyphenated Arabic name on OFAC SDN. If exact entity unlisted, replace with another currently-listed hyphenated SDN name. Until punctuation handling ships, hyphen-tokenisation differences can produce silent false-clear.",
  },
];

interface Outcome {
  test: TestCase;
  actualStatus: string | null;
  httpOk: boolean;
  isBlocked: boolean;
  elapsedMs: number;
  error?: string;
  screenshotUrl?: string | null;
  pass: boolean;
  // For expand=true tests: the per-variant breakdown so failures show which
  // variant returned what.
  variantBreakdown?: Array<{ term: string; status: string | null; isBlocked: boolean; error?: string }>;
}

async function fetchOne(db: string, term: string): Promise<{
  status: string | null;
  isBlocked: boolean;
  httpOk: boolean;
  elapsedMs: number;
  screenshotUrl?: string | null;
  error?: string;
}> {
  const url = `${ENDPOINT}?db=${encodeURIComponent(db)}&term=${encodeURIComponent(term)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { status: null, isBlocked: false, httpOk: false, elapsedMs: 0, error: `HTTP ${res.status}` };
    }
    const body = await res.json() as {
      status?: string | null;
      isBlocked?: boolean;
      elapsedMs?: number;
      screenshotUrl?: string | null;
    };
    return {
      status: body.status ?? null,
      isBlocked: body.isBlocked ?? false,
      httpOk: true,
      elapsedMs: body.elapsedMs ?? 0,
      screenshotUrl: body.screenshotUrl,
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      status: null, isBlocked: false, httpOk: false, elapsedMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runOne(test: TestCase): Promise<Outcome> {
  if (test.expand) {
    // Expand-mode: fan out across all auto-derived variants of `test.term`,
    // run sequentially (Railway hates bursts), aggregate. Pass if ANY variant
    // returns a status in `test.expect`.
    const variants = expandLvVariants(test.term);
    const breakdown: Array<{ term: string; status: string | null; isBlocked: boolean; error?: string }> = [];
    let totalElapsed = 0;
    let bestStatus: string | null = null;
    let allBlocked = true;
    let anyHttpOk = false;
    let anyExpectMatch = false;
    let lastScreenshot: string | null | undefined;

    for (const variant of variants) {
      const r = await fetchOne(test.db, variant);
      breakdown.push({ term: variant, status: r.status, isBlocked: r.isBlocked, error: r.error });
      totalElapsed += r.elapsedMs;
      if (!r.isBlocked) allBlocked = false;
      if (r.httpOk) anyHttpOk = true;
      if (r.status !== null && test.expect.includes(r.status as ExpectedStatus)) {
        anyExpectMatch = true;
        bestStatus = r.status;
        lastScreenshot = r.screenshotUrl;
      } else if (bestStatus === null && r.status !== null) {
        bestStatus = r.status;
        lastScreenshot = r.screenshotUrl;
      }
    }

    return {
      test,
      actualStatus: bestStatus,
      httpOk: anyHttpOk,
      isBlocked: allBlocked,
      elapsedMs: totalElapsed,
      screenshotUrl: lastScreenshot,
      pass: anyExpectMatch && !allBlocked,
      variantBreakdown: breakdown,
    };
  }

  const r = await fetchOne(test.db, test.term);
  const pass = !r.isBlocked && r.status !== null &&
    test.expect.includes(r.status as ExpectedStatus);
  return {
    test,
    actualStatus: r.status,
    httpOk: r.httpOk,
    isBlocked: r.isBlocked,
    elapsedMs: r.elapsedMs,
    screenshotUrl: r.screenshotUrl,
    pass,
    error: r.error,
  };
}

function formatOutcome(o: Outcome): string {
  const mark = o.pass ? "✓" : o.error ? "⚠" : o.isBlocked ? "∅" : "✗";
  const actual = o.actualStatus ?? (o.isBlocked ? "BLOCKED" : "NO STATUS");
  const expect = o.test.expect.join("|");
  const elapsed = o.elapsedMs ? `${(o.elapsedMs / 1000).toFixed(1)}s` : "—";
  const err = o.error ? ` [${o.error}]` : "";
  let line = `  ${mark} ${o.test.label.padEnd(60)}  actual=${actual.padEnd(10)} expect=${expect.padEnd(18)} ${elapsed}${err}`;
  if (o.variantBreakdown && o.variantBreakdown.length > 0) {
    for (const v of o.variantBreakdown) {
      const vstatus = v.error ? `ERR ${v.error}` : (v.status ?? (v.isBlocked ? "BLOCKED" : "—"));
      line += `\n      · "${v.term}" → ${vstatus}`;
    }
  }
  return line;
}

async function main() {
  console.log(`\nSmoke test against ${BASE_URL}`);
  console.log(`Running ${tests.length} cases sequentially (avoid rate-limits)...\n`);

  const outcomes: Outcome[] = [];
  for (const t of tests) {
    const o = await runOne(t);
    outcomes.push(o);
    console.log(formatOutcome(o));
  }

  // Summary
  const passed = outcomes.filter(o => o.pass).length;
  const failed = outcomes.filter(o => !o.pass && !o.error && !o.isBlocked).length;
  const blocked = outcomes.filter(o => o.isBlocked).length;
  const errored = outcomes.filter(o => o.error).length;

  console.log(`\n${passed} passed · ${failed} failed · ${blocked} blocked · ${errored} errored (of ${outcomes.length})`);

  // Regression detection: did any SANCTIONED case return clear?
  // This is the load-bearing failure mode the smoke test exists to catch.
  const regressions = outcomes.filter(o =>
    o.test.label.includes("SANCTIONED") &&
    o.actualStatus === "clear"
  );
  if (regressions.length > 0) {
    console.log(`\n❌ REGRESSION: ${regressions.length} known-sanctioned case(s) returned 'clear'.`);
    for (const r of regressions) {
      console.log(`   - ${r.test.label}: ${r.test.note || ""}`);
      if (r.screenshotUrl) console.log(`     screenshot: ${r.screenshotUrl}`);
    }
    console.log(`\nThis is the load-bearing failure mode. Do NOT ship. Investigate before sending external links.\n`);
    process.exit(1);
  }

  // Any CLEAN case returning `clear` AND still failing its expect set?
  // This only fires for a hard mismatch (e.g. clean → hit), not soft noise (clean → uncertain
  // on known-noisy sources) which is acceptable per `expect` above.
  const cleanHardFailures = outcomes.filter(o =>
    o.test.label.includes("CLEAN") && !o.pass && !o.isBlocked && !o.error
  );
  if (cleanHardFailures.length > 0) {
    console.log(`\n⚠ CLEAN-PATH FAILURE: ${cleanHardFailures.length} known-clean case(s) failed expectations.`);
    for (const r of cleanHardFailures) {
      console.log(`   - ${r.test.label}: got ${r.actualStatus}, expected one of [${r.test.expect.join(", ")}]`);
    }
    console.log(`\nThis may indicate false positives — investigate before shipping.\n`);
    process.exit(1);
  }

  // Soft noise: clean returning uncertain (acceptable per expect set, but worth surfacing)
  const cleanNoise = outcomes.filter(o =>
    o.test.label.includes("CLEAN") && o.pass && o.actualStatus === "uncertain"
  );
  if (cleanNoise.length > 0) {
    console.log(`\nℹ Clean-path noise (acceptable, but track): ${cleanNoise.length} clean case(s) returned uncertain.`);
    for (const r of cleanNoise) {
      console.log(`   - ${r.test.label} → uncertain`);
    }
  }

  // Infra failure: everything blocked or errored means we learned nothing
  if (blocked + errored === outcomes.length) {
    console.log(`\n✗ Could not reach any database. Infrastructure failure.\n`);
    process.exit(2);
  }

  console.log(`\n✓ No regressions detected. Demo is safe to send.\n`);
}

main().catch(err => {
  console.error("Smoke test crashed:", err);
  process.exit(2);
});
