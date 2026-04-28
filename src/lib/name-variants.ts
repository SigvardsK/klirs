/**
 * Latvian-aware name variant expansion.
 *
 * Latvian grammar appends a masculine nominative suffix `-s` (or `-š` after sibilants)
 * to foreign personal names: Russian "Пётр Авен" → Latvian "Pjotrs Avens"; English
 * "John Smith" → Latvian "Džons Smits". Sanctions/PEP databases index names under
 * different conventions: Firmas (LV-aggregated FID list) holds the LV-suffixed form;
 * OFAC and UK hold the canonical Latin transliteration without the LV suffix.
 *
 * A user who enters one spelling cannot match the other source. This module
 * generates both directions deterministically without a real transliteration table.
 *
 * Heuristic: for each whitespace-separated token of length ≥ 4, generate two
 * per-token transforms:
 *   - drop trailing `s`/`š` (LV → canonical)
 *   - add trailing `s` if absent (canonical → LV)
 *
 * Combine per-token to produce up to 2^N whole-name variants. Set-dedupe.
 * Cap at 4 variants per input. Original always preserved as variants[0].
 *
 * This is intentionally over-generative — false-positive variants ("Microsofts
 * Corporation") are harmless against indexed sanctions lists (the source
 * returns 0 results), while false-negative omissions cost the reviewer a
 * sanctioned hit they should have caught.
 *
 * Origin: a 2026-04-24 stress-test. "Pjotr Avens" with no aliases returned
 * all-clear — Firmas indexes "Pjotrs Avens", OFAC indexes "PETR AVEN", and
 * the engine queried only the literal "Pjotr Avens" the user typed.
 */

const MIN_TOKEN_LEN = 4;
const MAX_VARIANTS = 4;
const LV_SUFFIXES = ["s", "š"];

function endsWithLvSuffix(token: string): boolean {
  return LV_SUFFIXES.some(s => token.endsWith(s));
}

function tokenTransforms(token: string): string[] {
  if (token.length < MIN_TOKEN_LEN) return [token];
  const out = new Set<string>([token]);
  if (endsWithLvSuffix(token)) {
    // Drop the LV suffix → canonical Latin form.
    out.add(token.slice(0, -1));
  } else {
    // Add LV `s` → Latvian-suffixed form.
    out.add(token + "s");
  }
  return Array.from(out);
}

/**
 * Expand a name into transliteration variants.
 *
 * Returns the original first, followed by up to `MAX_VARIANTS - 1` deduplicated
 * variants. Whitespace and casing are preserved per token; only trailing-letter
 * morphology changes.
 */
export function expandLvVariants(name: string): string[] {
  // Normalize internal whitespace so that "Vladimirs   Putins" doesn't double-occupy
  // a variant slot alongside the cartesian-product "Vladimirs Putins".
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) return [];

  const tokens = trimmed.split(" ");
  const perToken = tokens.map(tokenTransforms);

  // Cartesian product across tokens — small in practice (each token yields ≤2 forms,
  // and we cap total variants at 4 below).
  let combos: string[][] = [[]];
  for (const forms of perToken) {
    const next: string[][] = [];
    for (const combo of combos) {
      for (const form of forms) {
        next.push([...combo, form]);
      }
    }
    combos = next;
  }

  const seen = new Set<string>();
  const out: string[] = [];
  // Always emit the original first so callers can rely on variants[0] === input.
  out.push(trimmed);
  seen.add(trimmed);

  for (const combo of combos) {
    if (out.length >= MAX_VARIANTS) break;
    const candidate = combo.join(" ");
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }

  return out;
}

/**
 * Test whether a string came from auto-expansion vs. user input.
 *
 * Used by the Checks tab UI and the form preview to label variants the user
 * did NOT type explicitly. `original` here is the de-duped union of the user's
 * primary entity name + all explicit aliases.
 */
export function isAutoVariant(searchTerm: string, originals: string[]): boolean {
  const set = new Set(originals.map(o => o.trim()));
  return !set.has(searchTerm.trim());
}
