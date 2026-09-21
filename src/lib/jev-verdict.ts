/**
 * Jev (TypeSafe System One) verdict layer — Phase A.
 *
 * Replaces the brittle string-match verdict (`classifyResult`) with a calibrated
 * read of the captured page, WITHOUT touching retrieval, screenshots, Supabase,
 * or the audit PDF. It is:
 *   - ADDITIVE + FLAG-GATED: only active when JEV_VERDICT=1 and TYPESAFE_API_KEY is set.
 *   - FALLBACK-SAFE: any Jev error/timeout returns the deterministic result verbatim,
 *     so a vendor outage degrades to today's behaviour — never a broken screen and
 *     never a false `clear` (LR-WS-2026-028, LR-WS-2026-029).
 *   - A/B-LOGGED: the deterministic verdict is preserved in the `reason` string for
 *     side-by-side comparison on real screens before Jev is trusted alone.
 *   - SAFETY-FLOORED: never returns `clear` unless retrieval is positively verified
 *     (the source's no-results indicator present, or a significant subject token on
 *     the page). Jev's score is evidence weight; the human still signs off.
 *
 * Rationale + spike evidence: Outlast/.claude/decision-records/DR-20260921-jev-fast-concurrent-aml-screen.md
 */
import type { CheckResult } from "./screening-engine";
import type { DbConfig } from "./db-configs";

const API_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const TIMEOUT_MS = Number(process.env.JEV_TIMEOUT_MS ?? 20000);

export function jevEnabled(): boolean {
  return process.env.JEV_VERDICT === "1" && !!process.env.TYPESAFE_API_KEY;
}

const LEGAL_FORMS = new Set([
  "sia", "as", "ooo", "uab", "oü", "ou", "ltd", "gmbh", "ab", "oy", "plc", "llc", "zs",
]);

/** Significant tokens (len>3, not a legal-form word) used to verify the page concerns the subject. */
function sigTokens(term: string): string[] {
  return term
    .replace(/"/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !LEGAL_FORMS.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());
}

/**
 * Surface the lines carrying the verdict signal so they are not buried in page
 * boilerplate (OFAC's ASP.NET disclaimer, cookie walls, nav). Generic across sources.
 */
function salient(pageText: string, term: string): string {
  const pats =
    /(lookup results|records? found|\bfound\b|atrasti|nav atrasti|neatbilst|no results|has not returned|sdn|sanction|pep|designated)/i;
  const toks = sigTokens(term);
  const keep: string[] = [];
  for (const raw of (pageText || "").split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    if (pats.test(s) || toks.some((t) => s.toLowerCase().includes(t))) {
      keep.push(s.slice(0, 160));
    }
    if (keep.length >= 20) break;
  }
  return keep.join("\n") || "(no salient lines extracted)";
}

interface NoulAnswer { noul: number }
interface SystemOneResponse { answers: Record<string, NoulAnswer> }

async function askJev(state: string): Promise<{ isClear: number; realHit: number; isSubject: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state,
        model: MODEL,
        questions: {
          is_clear: {
            type: "noul",
            instructions:
              "Does this page show NO real match for the searched name (a clean/no-results page)?",
          },
          real_hit: {
            type: "noul",
            instructions:
              "Does this page display a REAL sanctions/PEP/adverse record whose name matches the searched person or entity?",
          },
          is_subject: {
            type: "noul",
            instructions:
              "If a record is shown, is it plausibly the SAME party searched (not a mere namesake or token match)?",
          },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = (await res.json()) as SystemOneResponse;
    return {
      isClear: data.answers.is_clear.noul,
      realHit: data.answers.real_hit.noul,
      isSubject: data.answers.is_subject.noul,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compute the Jev verdict for a captured page. `deterministic` is the string-match
 * result from `classifyResult`, used as the retrieval-verification signal and as the
 * fallback on any Jev failure.
 */
export async function classifyWithJev(
  pageText: string,
  db: Pick<DbConfig, "noResultsIndicator" | "hitIndicator" | "hitIndicatorPattern" | "name">,
  searchTerm: string,
  deterministic: CheckResult,
): Promise<CheckResult> {
  if (!jevEnabled()) return deterministic;
  try {
    const state =
      `SOURCE: ${db.name}\nSUBJECT searched: ${searchTerm}\n\n` +
      `KEY RESULT LINES (extracted):\n${salient(pageText, searchTerm)}\n\n` +
      `FULL PAGE TEXT:\n${(pageText || "").slice(0, 3000)}`;
    const { isClear, realHit, isSubject } = await askJev(state);

    // Retrieval-verification floor: never `clear` unless we can prove the search ran.
    const low = (pageText || "").toLowerCase();
    const indicatorPresent =
      !!db.noResultsIndicator && low.includes(db.noResultsIndicator.toLowerCase());
    const tokenPresent = sigTokens(searchTerm).some((t) => low.includes(t));
    const retrieved = indicatorPresent || tokenPresent;

    let status: CheckResult["status"];
    if (!retrieved) {
      status = "uncertain"; // search did not demonstrably execute — never clear
    } else if (realHit >= 0.6 && isSubject >= 0.4) {
      status = "hit";
    } else if (isClear >= 0.6) {
      status = "clear";
    } else {
      status = "uncertain";
    }

    const scores = `clear=${isClear.toFixed(2)} hit=${realHit.toFixed(2)} subj=${isSubject.toFixed(2)} retrieved=${retrieved}`;
    const reason =
      `[jev ${status}] ${scores}` +
      ` | [string-match ${deterministic.status}]${deterministic.reason ? ` ${deterministic.reason}` : ""}`;

    return {
      status,
      reason,
      pageTextExcerpt: deterministic.pageTextExcerpt ?? (pageText || "").slice(0, 2000),
    };
  } catch (err) {
    // Vendor failure → deterministic verdict verbatim, annotated for the audit trail.
    const note = err instanceof Error ? err.message : String(err);
    return {
      ...deterministic,
      reason: `${deterministic.reason ?? deterministic.status} [jev-fallback: ${note.slice(0, 120)}]`,
    };
  }
}
