"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowRight, Loader2, Search, Sparkles } from "lucide-react";

interface RunResponse {
  screeningId?: string;
  error?: string;
  retryAfterSeconds?: number;
  runsPerDay?: number;
  remaining?: number;
}

interface Props {
  placeholderIndividual: string;
  placeholderEntity: string;
  ctaLabel: string;
  ctaSubmittingLabel: string;
  entityIndividualLabel: string;
  entityCompanyLabel: string;
  entityHelper: string;
  companyNudge: string;
  confirmButton: string;
  /** Interpolated template — call buildRecap(name, typeLabel) to fill. */
  confirmRecapTemplate: string;
  sampleLabel: string;
  sampleCleanName: string;
  sampleSanctionedName: string;
  sampleEntityName: string;
  rateLimitedMessage: string;
  genericErrorMessage: string;
}

/**
 * Company-signal tokens for the C2 nudge heuristic. A name that contains one of
 * these as a *whole word* (or a trailing legal-form suffix) while "Individual"
 * is selected most likely refers to a business — we surface a one-click switch.
 *
 * The list is deliberately conservative: token match is required, never
 * word-count alone, so ordinary personal names ("Jānis Bērziņš") never trigger.
 * Tokens are matched case-insensitively as whole tokens, so "AS" matches the
 * legal form "AS Air Baltic" but not the surname "Asnis".
 */
const COMPANY_SIGNAL_TOKENS = [
  // Legal forms / suffixes
  "SIA", "AS", "IK", "ZS", "Ltd", "LLC", "Inc", "Corp", "GmbH",
  "OÜ", "AB", "Oy", "PLC",
  // Corporate keywords
  "Group", "Holding", "Holdings", "Prefab", "Bank", "Capital",
  "Partners", "Industries", "Systems", "Solutions", "Technologies",
] as const;

// "A/S" and "Inc." carry punctuation that the \b token split would break apart,
// so they get a dedicated substring pass below.
const COMPANY_SIGNAL_PHRASES = ["A/S", "Inc."] as const;

const NORMALIZED_TOKENS = new Set(
  COMPANY_SIGNAL_TOKENS.map((t) => t.toLowerCase())
);

/**
 * True if the typed name carries a company signal. Splits on whitespace and
 * strips trailing/leading punctuation per token before comparing to the token
 * set, so "Skonto Prefab", "AS Air Baltic", "Acme Group." all match while
 * personal names do not.
 */
function looksLikeCompany(raw: string): boolean {
  const name = raw.trim();
  if (!name) return false;
  const lower = name.toLowerCase();
  // Phrase pass (punctuation-bearing forms).
  for (const phrase of COMPANY_SIGNAL_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) return true;
  }
  // Whole-token pass.
  const tokens = lower
    .split(/\s+/)
    .map((tok) => tok.replace(/^[^\p{L}\p{N}/]+|[^\p{L}\p{N}/]+$/gu, ""));
  return tokens.some((tok) => NORMALIZED_TOKENS.has(tok));
}

/**
 * Landing hero form — replaces the old 3-CTA hero. Single screening box, the
 * primary action above the fold. On submit POSTs to /api/demo/run and pushes
 * the visitor to /screen/[id]?left=<remaining> for the rich progress + result
 * render (the result page surfaces the free-searches-left signup nudge).
 *
 * Mistake-prevention bundle (entity-type mix-up):
 *   - C1 helper microcopy under the prominent segmented toggle
 *   - C2 client-side company-name nudge (one-click switch to Company)
 *   - C3 confirm recap — first submit shows "Screening X as Y", second submits;
 *     recap renders in warning style when C2 detects a likely mismatch
 *   - C4 prefill from ?name=&type= so a corrected re-run costs one click
 *
 * Sample chips intentionally include `Pjotrs Avens` — a sanctioned individual.
 * Compliance buyers' first instinct on any AML demo is to type a name they
 * KNOW is sanctioned to verify the engine catches it (the audit-wedge made
 * touchable). The chip surfaces this case discoverably.
 *
 * Composes with LR-WS-2026-029: if /api/demo/run fails closed (rate-limit,
 * misconfig, validation) we surface an explicit message — never silent retry.
 */
export function LandingHeroForm({
  placeholderIndividual,
  placeholderEntity,
  ctaLabel,
  ctaSubmittingLabel,
  entityIndividualLabel,
  entityCompanyLabel,
  entityHelper,
  companyNudge,
  confirmButton,
  confirmRecapTemplate,
  sampleLabel,
  sampleCleanName,
  sampleSanctionedName,
  sampleEntityName,
  rateLimitedMessage,
  genericErrorMessage,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState<"individual" | "company">(
    "individual"
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // C3: confirm recap is shown on first submit; second submit (Confirm) runs.
  const [confirming, setConfirming] = useState(false);

  // C4: prefill name + entity type from query params (?name=&type=). Validates
  // type ∈ {individual, company}; runs once on mount.
  useEffect(() => {
    const qName = searchParams.get("name");
    const qType = searchParams.get("type");
    if (qName) setName(qName);
    if (qType === "individual" || qType === "company") setEntityType(qType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // C2: does the typed name look like a company while Individual is selected?
  const mismatch = entityType === "individual" && looksLikeCompany(name);

  const submitScreening = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/demo/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), entityType }),
      });
      const data: RunResponse = await res.json();
      if (!res.ok || !data.screeningId) {
        if (res.status === 429) {
          setError(rateLimitedMessage);
        } else {
          setError(data.error || genericErrorMessage);
        }
        setSubmitting(false);
        return;
      }
      // B-UI: pass remaining free-search count through to the result page so it
      // can render the signup nudge ("N free searches left" / "last free").
      const remaining =
        typeof data.remaining === "number" ? data.remaining : 0;
      router.push(`/screen/${data.screeningId}?left=${remaining}`);
    } catch {
      setError(genericErrorMessage);
      setSubmitting(false);
    }
  }, [name, entityType, router, rateLimitedMessage, genericErrorMessage]);

  const onSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim() || submitting) return;
      // C3: first click reveals the recap; second click (Confirm) submits.
      if (!confirming) {
        setConfirming(true);
        return;
      }
      void submitScreening();
    },
    [name, submitting, confirming, submitScreening]
  );

  const handleSampleClick = useCallback(
    (sampleName: string, type: "individual" | "company") => {
      setName(sampleName);
      setEntityType(type);
      // Editing the entity invalidates any pending recap.
      setConfirming(false);
    },
    []
  );

  // Editing the name or flipping the type after the recap appears must reset it
  // so a subsequent Confirm reflects the current state (C3 requirement).
  const onNameChange = useCallback((value: string) => {
    setName(value);
    setConfirming(false);
  }, []);

  const setType = useCallback((type: "individual" | "company") => {
    setEntityType(type);
    setConfirming(false);
  }, []);

  const placeholder =
    entityType === "individual" ? placeholderIndividual : placeholderEntity;

  const typeLabel =
    entityType === "individual" ? entityIndividualLabel : entityCompanyLabel;

  const recapText = confirmRecapTemplate
    .replace("{name}", name.trim())
    .replace("{type}", typeLabel);

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Entity-type segmented toggle (C1 — prominent, not muted-grey) */}
      <div className="space-y-2">
        <div
          role="radiogroup"
          aria-label="Entity type"
          className="inline-flex rounded-lg border border-border bg-muted p-1 text-sm"
        >
          <button
            type="button"
            role="radio"
            aria-checked={entityType === "individual"}
            onClick={() => setType("individual")}
            className={`px-4 py-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              entityType === "individual"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-background/60"
            }`}
          >
            {entityIndividualLabel}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={entityType === "company"}
            onClick={() => setType("company")}
            className={`px-4 py-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              entityType === "company"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-background/60"
            }`}
          >
            {entityCompanyLabel}
          </button>
        </div>
        {/* C1 helper microcopy */}
        <p className="text-xs text-muted-foreground">{entityHelper}</p>
      </div>

      {/* Search row */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder={placeholder}
            maxLength={120}
            required
            disabled={submitting}
            autoFocus
            className="w-full h-14 pl-12 pr-4 rounded-lg bg-card border border-border text-foreground placeholder:text-muted-foreground text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-shadow shadow-sm hover:shadow"
          />
        </div>
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="inline-flex items-center justify-center gap-2 h-14 px-7 rounded-lg bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-slate-950 font-semibold text-base transition-colors disabled:opacity-60 disabled:cursor-not-allowed shadow-sm hover:shadow"
        >
          {submitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              {ctaSubmittingLabel}
            </>
          ) : confirming ? (
            <>
              {confirmButton}
              <ArrowRight className="w-4 h-4" />
            </>
          ) : (
            <>
              {ctaLabel}
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>

      {/* C2 nudge — non-blocking inline suggestion with one-click switch.
          Suppressed once the recap is up (the recap itself carries the warning
          styling at that point, so we avoid stacking two interruptions). */}
      {mismatch && !confirming && (
        <div className="flex flex-wrap items-center gap-2 text-sm rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-amber-900 dark:text-amber-100">{companyNudge}</span>
          <button
            type="button"
            onClick={() => setType("company")}
            className="ml-auto inline-flex items-center font-medium text-amber-900 dark:text-amber-100 underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            {entityCompanyLabel}
          </button>
        </div>
      )}

      {/* C3 confirm recap — first-click surface. Warning style when C2 detects a
          likely mismatch, neutral otherwise. Includes a quick type-flip link so
          the buyer can correct the type without leaving the recap. */}
      {confirming && !submitting && (
        <div
          className={`flex flex-wrap items-center gap-x-3 gap-y-2 text-sm rounded-md border px-4 py-3 ${
            mismatch
              ? "border-amber-500/40 bg-amber-500/10"
              : "border-border bg-muted/60"
          }`}
        >
          {mismatch && (
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
          )}
          <span
            className={
              mismatch
                ? "text-amber-900 dark:text-amber-100"
                : "text-foreground"
            }
          >
            {recapText}
          </span>
          <button
            type="button"
            onClick={() =>
              setType(entityType === "individual" ? "company" : "individual")
            }
            className="ml-auto inline-flex items-center font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded text-muted-foreground hover:text-foreground"
          >
            {entityType === "individual" ? entityCompanyLabel : entityIndividualLabel}
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-md px-4 py-3"
        >
          {error}
        </div>
      )}

      {/* Sample chips — discoverable fixtures incl. one sanctioned individual */}
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Sparkles className="w-3.5 h-3.5" />
        <span>{sampleLabel}</span>
        <button
          type="button"
          onClick={() => handleSampleClick(sampleCleanName, "individual")}
          className="inline-flex items-center px-2.5 py-1 rounded-full bg-card hover:bg-muted border border-border text-foreground text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {sampleCleanName}
        </button>
        <button
          type="button"
          onClick={() => handleSampleClick(sampleSanctionedName, "individual")}
          className="inline-flex items-center px-2.5 py-1 rounded-full bg-card hover:bg-muted border border-border text-foreground text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {sampleSanctionedName}
        </button>
        <button
          type="button"
          onClick={() => handleSampleClick(sampleEntityName, "company")}
          className="inline-flex items-center px-2.5 py-1 rounded-full bg-card hover:bg-muted border border-border text-foreground text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {sampleEntityName}
        </button>
      </div>
    </form>
  );
}
