/**
 * Adversarial-input detector for the screening classifier.
 *
 * Identifies input strings that the current name-variants engine cannot
 * reliably canonicalise against the indexed forms in OFAC / UK / Firmas /
 * VID / DDG. When detected, the classifier MUST upgrade a `clear` verdict
 * to `uncertain` so a human reviewer is in the loop.
 *
 * Why this exists (not the full B6 transformer pipeline):
 *   The audit at docs/sprint-2/PHONETIC-AUDIT.md §3 enumerates 5 gap
 *   classes; B6 P0 (full Cyrillic transliteration + initial expansion +
 *   punctuation normalisation) is genuinely Phase B work. This module is
 *   the *contract repair* — it preserves LR-WS-2026-029 (neutral default =
 *   uncertain, not clear) without claiming we've solved the matching
 *   problem. Adversarial inputs that don't surface a positive hit elsewhere
 *   surface as uncertain, never silently as clean.
 *
 * Failure mode this prevents:
 *   User enters `Пётр Авен` (Cyrillic). Every source indexes Latin, so every
 *   variant query returns the source's no-results indicator → classifier
 *   says `clear` → smoke-tested 2026-04-30 against deployed env, confirmed
 *   silent false-clear on a confirmed-sanctioned individual. With this
 *   detector wired into classifyResult, the same path returns `uncertain
 *   (adversarial: cyrillic)` and the human reviewer sees the verdict that
 *   the Latin transliteration is unverified.
 *
 * Out of scope (deferred to Phase B B6):
 *   Actually translating Cyrillic to Latin, expanding initials, normalising
 *   hyphens/apostrophes. The audit doc §4 has the implementation sketch.
 */

export type AdversarialClass = "cyrillic" | "initial" | "punctuation";

export interface AdversarialInputResult {
  isAdversarial: boolean;
  classes: AdversarialClass[];
}

// Cyrillic Unicode ranges: basic + supplement
const CYRILLIC_RE = /[Ѐ-ӿԀ-ԯ]/;

// Standalone initial — single Latin/Cyrillic letter followed by a period and
// (optionally) whitespace and another token. Captures "P. Avens", "В. Путин",
// "J. Doe" but NOT "St. Petersburg" (more than one letter before period).
const INITIAL_RE = /(?:^|\s)[A-Za-zА-Яа-я]\.(?:\s|$)/;

// Hyphen (regular or non-breaking) or apostrophe (straight or curly) anywhere
// in a non-trivial token. The Arabic-origin OFAC SDN names (Abdul-Rahim,
// AL-NA'IMI) and Slavic-style hyphenated surnames (Petrov-Vodkin) hit this.
// Note: this does NOT flag em-dashes or en-dashes — those are typographic and
// shouldn't appear in a name input.
const HYPHEN_OR_APOSTROPHE_RE = /[\-'’]/;

export function detectAdversarialInput(input: string): AdversarialInputResult {
  const classes: AdversarialClass[] = [];
  if (CYRILLIC_RE.test(input)) classes.push("cyrillic");
  if (INITIAL_RE.test(input)) classes.push("initial");
  if (HYPHEN_OR_APOSTROPHE_RE.test(input)) classes.push("punctuation");
  return { isAdversarial: classes.length > 0, classes };
}

/**
 * Human-readable reason string for the classifier override. Stored in
 * screening_checks.details so the reviewer sees why the verdict was
 * downgraded from the source's "no results" indicator to uncertain.
 */
export function adversarialReason(classes: AdversarialClass[]): string {
  if (classes.length === 0) return "";
  const labels: Record<AdversarialClass, string> = {
    cyrillic: "Cyrillic input — engine has not yet learned Cyrillic→Latin transliteration; sources index Latin only. Manual review required to confirm no match.",
    initial: "Abbreviated initial (e.g. \"P. Avens\") — engine has not yet learned initial expansion; sources index full first names. Manual review required.",
    punctuation: "Hyphen or apostrophe in input — source-side punctuation handling varies (OFAC token-strips hyphens; UK is space-tokenised). Manual review required.",
  };
  return classes.map((c) => labels[c]).join(" ");
}
