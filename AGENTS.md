<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

---

# Contributing as an AI agent

If you are Claude / Cursor / Copilot helping someone open a PR against this repo, read this file first. The rules below are not stylistic preferences — they exist because past regressions in this codebase produced silent false-clears on sanctioned individuals. That is the worst possible failure mode for a compliance tool.

## Load-bearing files

Three files carry the engine's correctness contract. Never modify them without running the smoke test:

- `src/lib/screening-engine.ts` — the tri-state classifier. The dual-affirmative invariant is documented at the top of the file. Read those lines before editing anything below them.
- `src/lib/db-configs.ts` — per-source `noResultsIndicator` and `hitIndicator` values. These are the affirmative signals the classifier reads. A wrong indicator silently re-introduces the false-clear failure mode.
- `src/lib/risk-score.ts` — category weighting. Changes here shift verdicts (LOW / MEDIUM / HIGH / REJECT) for every past screening; treat as a versioned contract.

## Regression tripwire

Before merging changes that touch any of the three files above, run:

```bash
npm run smoke:sanctioned
```

The smoke test asserts that known-sanctioned individuals (Petr Aven, Ramzan Kadyrov, Pjotrs Avens) **must not** return `clear` on any sanctions source. If it exits non-zero, do not merge. Include the output in the PR description.

## Detection defaults: never silently clear

The neutral default is `uncertain`, never `clear`. A `clear` verdict is an affirmative state requiring positive evidence — the source page's `noResultsIndicator` actually fired. Absence of signal means "I don't know" and must surface as `uncertain` for human review.

When adding a new source, both indicators are mandatory:
- `noResultsIndicator` — substring or pattern that proves the source returned zero matches
- `hitIndicator` — substring or pattern that proves the source matched the query

If you cannot identify both, the source is not ready to ship. Open an issue describing what page state would prove each verdict, and stop.

## Latent evidence contracts

When you add a Playwright capture step, write one line per captured artefact stating what it must prove. Common default traps that have shipped here before:

- **Viewport ≠ page.** A 1280×800 screenshot of a tall result list truncates evidence. Use full-page captures or set viewport explicitly when the result spans more than one screen.
- **`waitForNavigation` + sleep ≠ loaded.** Single-page-app sources (e.g. UR registry) hydrate after navigation completes. Wait for the actual element you intend to screenshot.
- **Name ≠ identity.** First-match on a non-unique name when a unique ID was supplied is a misclassification. Prefer registration-number lookup when available.

## Headless browser caveats

These sources are excluded by design — do not try to re-add them without solving the underlying detection problem first:

- **Lursoft** — Cloudflare Turnstile blocks headless access.
- **Namescan** — JA3 fingerprinting blocks `playwright-extra` + stealth.
- **Google web search from datacenter IPs** — blocked even with stealth. DuckDuckGo is the adverse-media source.

When verifying source behavior, test from the deployed Railway environment. Datacenter IPs behave differently from residential IPs; "works locally" is not a deployment signal.

## PR checklist

Before opening a PR, confirm:

- [ ] Sources cited for any new claim or change in classifier logic
- [ ] `npm run smoke:sanctioned` output included if you touched the load-bearing files
- [ ] No new code path that defaults to `clear` without an affirmative `noResultsIndicator`
- [ ] If you added a new source: both `noResultsIndicator` and `hitIndicator` defined, and a one-line evidence contract for every captured artefact
- [ ] If you touched Playwright: tested against the deployed environment, not just local

PRs that miss the smoke test on load-bearing changes will be asked to re-run before review.
