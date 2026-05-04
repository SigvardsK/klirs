/**
 * Database configurations for automated AML screening.
 * Selectors verified against the live source pages (LV/EU/UK/US sanctions
 * registries, LV registries, DuckDuckGo adverse media). Each entry is the
 * minimum required to drive Playwright through search → wait → screenshot.
 */

export interface DbConfig {
  id: string;
  name: string;
  url: string;
  category: string;
  searchSelector: string | null;
  lastNameSelector?: string | null;
  submitSelector: string | null;
  waitMs: number;
  waitForNavigation?: boolean;
  waitForTextChange?: boolean;
  noResultsIndicator: string | null;
  // Tri-state precedence (see `classifyResult` in screening-engine.ts):
  //   1. noResultsIndicator matches → `clear`
  //   2. hitIndicatorPattern matches (regex, count-aware) → `hit`
  //   3. hitIndicator matches (plain substring) → `hit`
  //   4. noResultsIndicator configured but text absent → `uncertain` (manual review)
  // Use hitIndicatorPattern when the source emits a count-bearing heading
  // (e.g. OFAC's `Lookup Results: N Found` — clean shows N=0, hits show N≥1;
  // a substring match would catch both layouts and rely on no-results-precedence
  // to filter clean, which fails-unsafe if the no-results phrasing ever changes).
  // Use hitIndicator when a single substring uniquely marks hits (UK's "records
  // found", Firmas' "rāda no 1").
  hitIndicator: string | null;
  hitIndicatorPattern?: RegExp | null;
  cookieSelector: string | null;
  rateLimit: number;
  filenamePrefix: string;
  companyOnly?: boolean;
  personsOnly?: boolean;
  jurisdictionCheck?: boolean;
  searchTemplates?: Record<string, string>;
  urlSearch?: boolean;
  // When set, a `hit` result against a COMPANY entity is downgraded to `uncertain`
  // with an explanatory reason. The check still runs (screenshot + source URL are
  // captured for the audit trail); we only refuse to claim the match is confirmed.
  // Use when the source has a known search-quality issue for multi-word company
  // queries (e.g., UK Sanctions' space-tokenised search treats "Microsoft
  // Corporation" as OR across tokens → 137 false records via "Corporation").
  // Individual screenings are unaffected — multi-word person names tokenise
  // accurately on UK (Petr Aven → 8 records, top = AVEN Petr Olegovich).
  downgradeCompanyHits?: boolean;
  // When set, the captured source_url points to the service landing page rather
  // than a deep-linked result (the source uses POST form submission and renders
  // results in place with no shareable result URL). The UI + PDF render a caveat
  // next to such URLs so reviewers don't expect to reproduce the screenshotted
  // result by clicking the link — the screenshot IS the evidence of record.
  resultUrlIsLandingOnly?: boolean;
  // Override the viewport height for this source's screenshot. Default is 1024px
  // (the context default). Use a taller viewport when the meaningful content —
  // typically the first 2–3 result rows — sits just below the 1024 fold, so the
  // viewport-only screenshot captures it without resorting to fullPage (which
  // adds footers, empty space, and moves the fixed-position evidence header to
  // the 1024 mark instead of the true bottom). Verified empirically 2026-04-23:
  // UK Sanctions and UR Registry both need ~1400 to show 2 records cleanly with
  // the evidence header still anchored at the bottom.
  viewportHeight?: number;
  // Per-source canary contract. When set, the daily GitHub Actions workflow
  // `.github/workflows/source-health-check.yml` runs the source against
  // `knownCleanTerm` (must observe `expectedCleanStatus`) and `knownSanctionedTerm`
  // (must observe `expectedSanctionedStatus`). A mismatch fails the workflow and
  // surfaces in the Actions tab — the buyer-facing answer to "how do you know
  // the tool doesn't silently break if a target page changes." Picks should be
  // stable: well-known sanctioned individuals on each list, and entities that
  // are robustly absent (Microsoft for sanctions; Jānis Bērziņš for LV PEP).
  healthCheck?: {
    knownCleanTerm: string;
    knownSanctionedTerm: string;
    expectedCleanStatus: "clear";
    expectedSanctionedStatus: "hit" | "uncertain";
  };
}

// Searchable databases (submit a query, get results)
// Note: Lursoft removed — Cloudflare Turnstile blocks headless browsers (2026-04-11).
// Firmas.lv covers the same aggregated sanctions data.
export const SEARCHABLE_DATABASES: DbConfig[] = [
  {
    id: "firmas_sanctions",
    name: "FID consolidated sanctions (via Firmas.lv)",
    url: "https://www.firmas.lv/lv/sankcijas",
    category: "sanctions",
    searchSelector: 'input[placeholder="Meklēt pēc vārda vai nosaukuma"]',
    submitSelector: null, // Enter key
    waitMs: 3000,
    noResultsIndicator: "Atrasti 0 ieraksti",
    // Latvian declension: `Atrasts 1 ieraksts` (singular) vs `Atrasti N ieraksti` (plural ≥2) vs
    // `Atrasti 0 ieraksti` (clean). Word stem overlaps between clean and plural hits, so the
    // cleanest discriminator is the pagination summary: `rāda no 1 līdz N` appears for any
    // N≥1; clean pages say `rāda no 0 līdz 0`. Verified 2026-04-23 against Pjotrs Avens (1),
    // Petr Aven (3), Kadyrov (13), and Microsoft (0).
    hitIndicator: "rāda no 1",
    cookieSelector: null, // No reliable selector — rely on DOM-removal fallback in screening-engine
    rateLimit: 1000,
    filenamePrefix: "firmas_sanctions",
    // Firmas fits the result table + pagination summary in the default 1024
    // viewport cleanly — no viewport extension needed.
    healthCheck: {
      knownCleanTerm: "Microsoft Corporation",
      knownSanctionedTerm: "Petr Aven",
      expectedCleanStatus: "clear",
      expectedSanctionedStatus: "hit",
    },
  },
  {
    id: "ofac_sdn",
    name: "OFAC SDN List (US Treasury)",
    url: "https://sanctionssearch.ofac.treas.gov/",
    category: "sanctions",
    // OFAC's single "Name" input is exposed as #ctl00_MainContent_txtLastName in the ASP.NET
    // markup — it accepts full names and does partial/token matching. The Latvian→Latin name
    // gap (e.g. "Pjotrs Avens" vs OFAC's "AVEN, PETR") is bridged by the aliases input on
    // the submission form, not by splitting fields here (no txtFirstName exists to fill).
    searchSelector: "#ctl00_MainContent_txtLastName",
    submitSelector: "#ctl00_MainContent_btnSearch",
    waitMs: 5000,
    noResultsIndicator: "Your search has not returned any results",
    hitIndicator: null,
    // OFAC's results page shows `Lookup Results: N Found` — clean queries return
    // N=0, hits return N≥1. The count-bearing heading is the only stable
    // discriminator across result layouts (no single keyword is unique to hits).
    // Regex matches ≥1 only, fails-safe: if OFAC ever rephrases, classifier
    // returns `uncertain` instead of falsely flipping clean → hit. Resolves a
    // false-uncertain on canonical sanctioned individuals (Petr Aven, Kadyrov)
    // where OFAC was the only sanctions source still returning "Review" while
    // UK + Firmas correctly returned hit.
    hitIndicatorPattern: /lookup results:\s*[1-9]\d*\s*found/i,
    cookieSelector: null,
    rateLimit: 3000,
    filenamePrefix: "ofac_sdn",
    healthCheck: {
      knownCleanTerm: "Microsoft Corporation",
      knownSanctionedTerm: "Petr Aven",
      expectedCleanStatus: "clear",
      expectedSanctionedStatus: "hit",
    },
  },
  {
    id: "uk_sanctions",
    name: "UK Sanctions List (GOV.UK)",
    url: "https://search-uk-sanctions-list.service.gov.uk/",
    category: "sanctions",
    searchSelector: "#search",
    submitSelector: "#search-submit",
    waitForTextChange: true,
    waitMs: 15000,
    noResultsIndicator: "No results found.",
    // UK GOV.UK SPA reports `N records found` on any non-empty result page. Verified 2026-04-23
    // against Petr Aven (8), Kadyrov (7), Microsoft (0 → No results found). Caveat: UK's search
    // is space-tokenised across multiple fields, so multi-word COMPANY queries may match
    // unrelated records via common words (e.g., "Microsoft Corporation" tokenises and hits
    // "Corporation" in 137 records). Acceptable in the current shape because individual
    // names tokenise distinctively; the `downgradeCompanyHits` flag below absorbs the
    // tokenisation risk for company entities. Tighter phrase matching is a Phase 4
    // improvement (post-filter or quoted-search).
    hitIndicator: "records found",
    cookieSelector: null,
    rateLimit: 2000,
    filenamePrefix: "uk_sanctions",
    // UK's result records are tall (~300px each). 1400 surfaces the search box
    // header + first 2 records + the evidence footer cleanly.
    viewportHeight: 1400,
    // See DbConfig.downgradeCompanyHits above for rationale. Check still runs for
    // companies — the screenshot is captured and the search term is recorded —
    // but a `hit` is downgraded to `uncertain` so the reviewer inspects the
    // screenshot rather than escalating to REJECT on a tokenisation artefact.
    downgradeCompanyHits: true,
    healthCheck: {
      // Single-word "Microsoft" avoids UK's space-tokenised false positive on
      // "Corporation" (137 records). Mirrors smoke-test convention.
      knownCleanTerm: "Microsoft",
      knownSanctionedTerm: "Petr Aven",
      expectedCleanStatus: "clear",
      expectedSanctionedStatus: "hit",
    },
  },
  {
    id: "vid_pnp",
    name: "VID PNP (Latvian Tax Debtors)",
    url: "https://www6.vid.gov.lv/PNP",
    category: "pep",
    searchSelector: "input#Name",
    submitSelector: 'input[type="submit"][name="search"]',
    waitForNavigation: true,
    // Bumped 4000→6000 on 2026-04-23: VID's POST-redirect-then-render pipeline
    // can exceed 4s for longer names or during backend load (observed mid-load
    // screenshots for Roman Abramovich). Paired with waitForLoadState('networkidle')
    // post-navigation in runDatabaseCheck.
    waitMs: 6000,
    noResultsIndicator: "Nav atrasti",
    hitIndicator: null,
    cookieSelector: null,
    rateLimit: 3000,
    filenamePrefix: "vid_pnp",
    personsOnly: true,
    resultUrlIsLandingOnly: true,
  },
  {
    id: "vid_vad",
    name: "VID VAD (Latvian Officials Declarations)",
    url: "https://www6.vid.gov.lv/VAD",
    category: "pep",
    searchSelector: "input#Name",
    lastNameSelector: "input#Surname",
    submitSelector: 'input[type="submit"][name="search"]',
    waitForNavigation: true,
    // Bumped 4000→6000 on 2026-04-23: see vid_pnp note.
    waitMs: 6000,
    noResultsIndicator: "neatbilst neviena",
    hitIndicator: null,
    cookieSelector: null,
    rateLimit: 3000,
    filenamePrefix: "vid_vad",
    personsOnly: true,
    resultUrlIsLandingOnly: true,
  },
];

// Adverse media (DuckDuckGo with playwright-extra stealth — URL-based, not form submission)
// DuckDuckGo chosen over Google: Google CAPTCHAs from datacenter IPs even with stealth plugin.
// DDG confirmed working with playwright-extra + stealth plugin from Railway egress.
export const ADVERSE_MEDIA_CONFIG: DbConfig = {
  id: "adverse_media",
  name: "DuckDuckGo Adverse Media Search",
  url: "https://duckduckgo.com/",
  category: "adverse_media",
  searchSelector: null,
  submitSelector: null,
  waitMs: 5000,
  noResultsIndicator: "No results found",
  hitIndicator: null,
  cookieSelector: null,
  rateLimit: 5000,
  filenamePrefix: "adverse_media",
  urlSearch: true,
  personsOnly: true,
  searchTemplates: {
    LV: '"{name}" noziegums VAI atmazgāšana VAI terorisms VAI sankcijas VAI krāpšana VAI korupcija',
    EN: '"{name}" crime OR launder OR terror OR sanction OR fraud OR corrupt OR bribe OR arrest',
    ET: '"{name}" kuritegu VÕI rahapesu VÕI terrorism VÕI sanktsioonid VÕI pettus VÕI korruptsioon',
    RU: '"{name}" преступление ИЛИ отмывание ИЛИ санкция ИЛИ мошенничество ИЛИ коррупция',
  },
};

// Company registry (only for company screenings)
export const COMPANY_REGISTRY_CONFIG: DbConfig = {
  id: "ur_registry",
  name: "Uzņēmumu reģistrs (Latvia)",
  url: "https://info.ur.gov.lv/#/data-search",
  category: "company_registry",
  searchSelector: null, // SPA — special handling in screening engine
  submitSelector: null,
  waitMs: 5000,
  noResultsIndicator: null,
  hitIndicator: null,
  cookieSelector: 'button:has-text("Aizvērt")', // Latvian "Close" cookie button
  rateLimit: 2000,
  filenamePrefix: "ur_registry",
  companyOnly: true,
  jurisdictionCheck: true,
  // UR result cards + detail sections + Persons list all benefit from extra
  // viewport height to show the first 2–3 items without scrolling.
  viewportHeight: 1400,
};
