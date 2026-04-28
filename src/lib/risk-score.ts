/**
 * Category-weighted risk score derivation.
 *
 * Replaces the bucketed toggle from the Phase 1 demo (`hit>0?900 : uncertain>0?180 : …`).
 * The previous model produced the same score regardless of whether one check or six
 * were uncertain, and could not distinguish a sanctions-category signal from an
 * adverse-media noise signal. That is not defensible to a compliance officer.
 *
 * This model is intentionally simple and rule-based — a compliance reviewer can trace
 * every contribution to a specific check. No LLM, no opaque weights. The breakdown is
 * rendered alongside the score in the UI so the number is never a magic constant.
 *
 * Bracket mapping (non-overlapping, ordered by precedence):
 *   REJECT     — any sanctions hit (confirmed match on OFAC / UK / FID).
 *   HIGH       — at least one sanctions-category uncertain OR a PEP hit.
 *   MEDIUM     — at least one PEP uncertain (no sanctions signal).
 *   LOW-MEDIUM — only adverse-media uncertainty.
 *   LOW        — all checks clear (or only trivial registry signal).
 *   INCOMPLETE — at least one check errored; rendered as a suffix flag on the bracket
 *                the score otherwise resolves to. Never hides the underlying risk.
 */

import type { ScreeningCheck, CheckStatus } from "./types";

export type RiskLevel = "LOW" | "LOW-MEDIUM" | "MEDIUM" | "HIGH" | "REJECT";

export interface RiskBreakdownRow {
  category: string;       // display label
  hits: number;           // count of `hit` in this category
  uncertains: number;     // count of `uncertain` in this category
  contribution: number;   // score contribution from this category
}

export interface RiskResult {
  level: RiskLevel;
  score: number;            // cumulative numeric score (bucket brackets listed below)
  incomplete: boolean;      // true if any `error` check — render as suffix flag
  breakdown: RiskBreakdownRow[];
}

// Score brackets (inclusive lower bound, exclusive upper):
//   LOW         0 – 40
//   LOW-MEDIUM 41 – 150
//   MEDIUM    151 – 400
//   HIGH      401 – 2000
//   REJECT    2001 +
// Anchored so: a single sanctions-uncertain lands in HIGH; a single PEP-uncertain in
// MEDIUM; a single adverse-media-uncertain in LOW-MEDIUM; any sanctions hit jumps to
// REJECT regardless of other signals.

interface CategoryRule {
  label: string;
  level: RiskLevel;              // level this category escalates to
  hitScore: number;              // fixed contribution per hit (sanctions hit → REJECT)
  uncertainBase: number;         // first uncertain in category
  uncertainPer: number;          // each additional uncertain
  uncertainCap: number;          // max contribution from uncertainty in this category
}

const CATEGORY_RULES: Record<string, CategoryRule> = {
  sanctions: {
    label: "Sanctions",
    level: "HIGH",               // uncertain escalates to HIGH; hits handled separately → REJECT
    hitScore: 2500,              // any single sanctions hit lands in REJECT
    uncertainBase: 600,
    uncertainPer: 50,
    uncertainCap: 900,
  },
  pep: {
    label: "PEP / Officials",
    level: "MEDIUM",
    hitScore: 450,               // a PEP hit is serious but not a REJECT on its own
    uncertainBase: 200,
    uncertainPer: 30,
    uncertainCap: 350,
  },
  adverse_media: {
    label: "Adverse Media",
    level: "LOW-MEDIUM",
    hitScore: 80,                // adverse media doesn't self-fire `hit` (no hitIndicator)
    uncertainBase: 50,
    uncertainPer: 10,
    uncertainCap: 150,
  },
  company_registry: {
    label: "Company Registry",
    level: "LOW",                // registry uncertainty is noise
    hitScore: 5,
    uncertainBase: 5,
    uncertainPer: 3,
    uncertainCap: 20,
  },
};

const BRACKET_THRESHOLDS: { threshold: number; level: RiskLevel }[] = [
  { threshold: 2001, level: "REJECT" },
  { threshold: 401,  level: "HIGH" },
  { threshold: 151,  level: "MEDIUM" },
  { threshold: 41,   level: "LOW-MEDIUM" },
  { threshold: 0,    level: "LOW" },
];

function resolveLevel(score: number): RiskLevel {
  for (const { threshold, level } of BRACKET_THRESHOLDS) {
    if (score >= threshold) return level;
  }
  return "LOW";
}

export function deriveRisk(checks: ScreeningCheck[]): RiskResult {
  const byCategory = new Map<string, { hits: number; uncertains: number; errors: number }>();

  for (const c of checks) {
    if (!byCategory.has(c.category)) {
      byCategory.set(c.category, { hits: 0, uncertains: 0, errors: 0 });
    }
    const bucket = byCategory.get(c.category)!;
    const status: CheckStatus = c.status;
    if (status === "hit") bucket.hits++;
    else if (status === "uncertain") bucket.uncertains++;
    else if (status === "error") bucket.errors++;
  }

  const breakdown: RiskBreakdownRow[] = [];
  let totalScore = 0;
  let incomplete = false;

  for (const [category, bucket] of byCategory.entries()) {
    if (bucket.errors > 0) incomplete = true;
    const rule = CATEGORY_RULES[category];
    if (!rule) continue; // unknown category — skip (never contributes to score)

    let contribution = 0;
    if (bucket.hits > 0) {
      contribution += bucket.hits * rule.hitScore;
    }
    if (bucket.uncertains > 0) {
      const uncCost = Math.min(
        rule.uncertainBase + Math.max(0, bucket.uncertains - 1) * rule.uncertainPer,
        rule.uncertainCap
      );
      contribution += uncCost;
    }

    if (contribution > 0 || bucket.hits > 0 || bucket.uncertains > 0) {
      breakdown.push({
        category: rule.label,
        hits: bucket.hits,
        uncertains: bucket.uncertains,
        contribution,
      });
      totalScore += contribution;
    }
  }

  // Sort breakdown by contribution (highest first) so the reviewer sees the driver.
  breakdown.sort((a, b) => b.contribution - a.contribution);

  return {
    level: resolveLevel(totalScore),
    score: totalScore,
    incomplete,
    breakdown,
  };
}
