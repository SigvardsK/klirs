"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Search, Sparkles } from "lucide-react";

interface RunResponse {
  screeningId?: string;
  error?: string;
  retryAfterSeconds?: number;
  runsPerDay?: number;
}

interface Props {
  placeholderIndividual: string;
  placeholderEntity: string;
  ctaLabel: string;
  ctaSubmittingLabel: string;
  entityIndividualLabel: string;
  entityCompanyLabel: string;
  sampleLabel: string;
  sampleCleanName: string;
  sampleSanctionedName: string;
  sampleEntityName: string;
  rateLimitedMessage: string;
  genericErrorMessage: string;
}

/**
 * Landing hero form — replaces the old 3-CTA hero. Single screening box, the
 * primary action above the fold. On submit POSTs to /api/demo/run and pushes
 * the visitor to /screen/[id] for the rich progress + result render.
 *
 * Sample chips intentionally include `Pjotrs Avens` — a sanctioned individual.
 * Compliance buyers' first instinct on any AML demo is to type a name they
 * KNOW is sanctioned to verify the engine catches it (the audit-wedge made
 * touchable). The chip surfaces this case discoverably rather than asking the
 * buyer to bring their own fixture.
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
  sampleLabel,
  sampleCleanName,
  sampleSanctionedName,
  sampleEntityName,
  rateLimitedMessage,
  genericErrorMessage,
}: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState<"individual" | "company">(
    "individual"
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim() || submitting) return;
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
        router.push(`/screen/${data.screeningId}`);
      } catch {
        setError(genericErrorMessage);
        setSubmitting(false);
      }
    },
    [name, entityType, submitting, router, rateLimitedMessage, genericErrorMessage]
  );

  const handleSampleClick = useCallback(
    (sampleName: string, type: "individual" | "company") => {
      setName(sampleName);
      setEntityType(type);
    },
    []
  );

  const placeholder =
    entityType === "individual" ? placeholderIndividual : placeholderEntity;

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Entity-type segmented toggle */}
      <div
        role="radiogroup"
        aria-label="Entity type"
        className="inline-flex rounded-md border border-border bg-card p-0.5 text-sm"
      >
        <button
          type="button"
          role="radio"
          aria-checked={entityType === "individual"}
          onClick={() => setEntityType("individual")}
          className={`px-3.5 py-1.5 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            entityType === "individual"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {entityIndividualLabel}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={entityType === "company"}
          onClick={() => setEntityType("company")}
          className={`px-3.5 py-1.5 rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
            entityType === "company"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {entityCompanyLabel}
        </button>
      </div>

      {/* Search row */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-5 h-5 absolute left-4 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
          ) : (
            <>
              {ctaLabel}
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>

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
