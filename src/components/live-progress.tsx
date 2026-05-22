"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  Camera,
  Loader2,
  Shield,
  Sparkles,
  X,
} from "lucide-react";
import { ScreeningViewer } from "./screening-viewer";
import { ThemeToggle } from "./theme-toggle";
import { isRateLimited, type Screening, type ScreeningCheck, type CheckStatus } from "@/lib/types";

/**
 * <LiveProgress> — public result-page client component.
 *
 * Mounted by /screen/[id]. Owns the polling loop and the running → done
 * transition. Renders one of three states:
 *
 *   - running:  status header + per-source progress (Phase 2 stub:
 *               flat list with status chip per check; Phase 4 rebuilds
 *               with screenshot thumbnails, lightbox, grouped categories)
 *   - stalled:  amber banner with "Run another" reset
 *   - done:     ScreeningViewer + PostResultCallouts (sign-in carrot +
 *               book-demo CTA)
 *
 * Note: this is the Phase 2 functional stub. Phase 4 rebuilds the running
 * view as a richer per-source waterfall with screenshots, lightbox, and
 * sticky elapsed counter. The polling contract + done-state behavior
 * stay the same — Phase 4 only swaps the running render.
 *
 * Composes with LR-WS-2026-029 (default UNCERTAIN — never silent clear) and
 * LR-WS-2026-038 (stuck-state probe — status route synthesizes `stalled` after
 * 5min silence; UI surfaces it explicitly, not as a tiny line).
 */

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — engine median ~60-90s, p99 ~3min
const BOOKING_URL =
  process.env.NEXT_PUBLIC_BOOKING_URL ||
  "mailto:sigvards.krongorns@gmail.com?subject=Book%20a%20Klirs%20demo";

interface StatusResponse {
  status: "pending" | "in_progress" | "completed" | "failed" | "stalled";
  raw_status: string;
  recoverable: boolean;
  checks_completed: number;
  checks_total: number;
  completed_at: string | null;
  latest_check: {
    database_name: string;
    category: string;
    status: string;
    checked_at: string;
  } | null;
  completed_checks: ScreeningCheck[];
}

interface ChecksResponse {
  screening: Screening;
  checks: ScreeningCheck[];
}

type Phase =
  | { kind: "running"; checks: ScreeningCheck[]; done: number; total: number; latest: StatusResponse["latest_check"] }
  | { kind: "stalled" }
  | { kind: "done"; screening: Screening; checks: ScreeningCheck[] }
  | { kind: "error"; message: string };

interface Props {
  screeningId: string;
  initialScreening: Screening;
  initialCompletedChecks: ScreeningCheck[];
  /**
   * Localized copy resolved server-side (the result page lives outside the
   * [locale] segment, so strings are passed in rather than read via next-intl
   * here). `freeLeftTemplate` is already plural-resolved against ?left=.
   */
  copy: ResultCopy;
}

export interface ResultCopy {
  runAnother: string;
  signIn: string;
  themeToLight: string;
  themeToDark: string;
  /** Plural-resolved server-side, e.g. "1 free search left today — …". */
  freeLeftTemplate: string;
  /** "That was your last free search today. Sign in to run more." */
  lastFree: string;
  saveResultTitle: string;
  saveResultBody: string;
  bookDemoTitle: string;
  bookDemoBody: string;
}

export function LiveProgress({
  screeningId,
  initialScreening,
  initialCompletedChecks,
  copy,
}: Props) {
  const [phase, setPhase] = useState<Phase>(() => {
    // Initial phase derived from server-side fetch — avoids a "flash of running"
    // when the screening is already completed at mount time.
    if (initialScreening.status === "completed") {
      return {
        kind: "done",
        screening: initialScreening,
        checks: initialCompletedChecks,
      };
    }
    if (initialScreening.status === "failed") {
      return { kind: "stalled" };
    }
    return {
      kind: "running",
      checks: initialCompletedChecks,
      done: initialScreening.checks_completed ?? 0,
      total: initialScreening.checks_total ?? 0,
      latest: null,
    };
  });

  const pollStartRef = useRef<number>(0);

  useEffect(() => {
    if (phase.kind !== "running") return;
    if (pollStartRef.current === 0) {
      pollStartRef.current = Date.now();
    }
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/demo/${screeningId}/status`);
        if (!res.ok) return;
        const data = (await res.json()) as StatusResponse;

        if (data.status === "completed") {
          const checksRes = await fetch(`/api/demo/${screeningId}/checks`);
          if (!checksRes.ok) {
            if (!cancelled)
              setPhase({
                kind: "error",
                message: "Could not fetch screening result.",
              });
            return;
          }
          const checksData = (await checksRes.json()) as ChecksResponse;
          if (!cancelled)
            setPhase({
              kind: "done",
              screening: checksData.screening,
              checks: checksData.checks,
            });
          return;
        }
        if (data.status === "failed" || data.status === "stalled") {
          if (!cancelled) setPhase({ kind: "stalled" });
          return;
        }
        if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
          if (!cancelled) setPhase({ kind: "stalled" });
          return;
        }
        if (!cancelled) {
          setPhase(prev =>
            prev.kind === "running"
              ? {
                  ...prev,
                  checks: data.completed_checks ?? prev.checks,
                  done: data.checks_completed ?? prev.done,
                  total: data.checks_total ?? prev.total,
                  latest: data.latest_check,
                }
              : prev
          );
        }
      } catch {
        // transient — retry next tick
      }
    };

    const interval = setInterval(tick, POLL_INTERVAL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase.kind, screeningId]);

  // ──────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────

  // C4: "Run another" link prefills the form with this screening's entity so a
  // mis-set entity type costs only the second free search, not a dead end.
  const runAnotherHref = buildRunAnotherHref(
    initialScreening.entity_name,
    initialScreening.entity_type
  );

  if (phase.kind === "done") {
    return (
      <ResultLayout
        entityName={phase.screening.entity_name}
        runAnotherHref={runAnotherHref}
        copy={copy}
      >
        <PostResultCallouts copy={copy} />
        <ScreeningViewer
          screening={phase.screening}
          checks={phase.checks}
          supabaseUrl={process.env.NEXT_PUBLIC_SUPABASE_URL || ""}
          demoMode={true}
        />
        <PostResultCallouts copy={copy} />
      </ResultLayout>
    );
  }

  if (phase.kind === "stalled") {
    return (
      <ResultLayout
        entityName={initialScreening.entity_name}
        runAnotherHref={runAnotherHref}
        copy={copy}
      >
        <StalledBanner runAnotherHref={runAnotherHref} />
      </ResultLayout>
    );
  }

  if (phase.kind === "error") {
    return (
      <ResultLayout
        entityName={initialScreening.entity_name}
        runAnotherHref={runAnotherHref}
        copy={copy}
      >
        <ErrorBanner message={phase.message} runAnotherHref={runAnotherHref} />
      </ResultLayout>
    );
  }

  return (
    <ResultLayout
      entityName={initialScreening.entity_name}
      runAnotherHref={runAnotherHref}
      copy={copy}
    >
      <RunningProgress phase={phase} />
    </ResultLayout>
  );
}

/** C4 — prefill the landing form via ?name=&type= so a re-run costs one click. */
function buildRunAnotherHref(
  entityName: string,
  entityType: "individual" | "company"
): string {
  const params = new URLSearchParams({ name: entityName, type: entityType });
  return `/?${params.toString()}`;
}

// ────────────────────────────────────────────────────────────────────────
// Sub-components
// ────────────────────────────────────────────────────────────────────────

function ResultLayout({
  entityName,
  runAnotherHref,
  copy,
  children,
}: {
  entityName: string;
  runAnotherHref: string;
  copy: ResultCopy;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="max-w-5xl mx-auto px-6 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Shield className="w-4 h-4 text-primary" />
            Klirs
          </Link>
          <div className="flex items-center gap-3 text-sm">
            <Link
              href={runAnotherHref}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              {copy.runAnother}
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center gap-1 h-9 px-3 rounded-md border border-border bg-card hover:bg-muted transition-colors"
            >
              {copy.signIn}
            </Link>
            <ThemeToggle
              toLightLabel={copy.themeToLight}
              toDarkLabel={copy.themeToDark}
            />
          </div>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Screening result
          </p>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">
            {entityName}
          </h1>
        </div>
        {children}
      </main>
    </div>
  );
}

function RunningProgress({
  phase,
}: {
  phase: Extract<Phase, { kind: "running" }>;
}) {
  const total = phase.total || 7;
  const done = phase.done;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  // Live elapsed timer — re-renders once per second while running
  const startedAt = useStartedAt();
  const elapsedSec = useElapsedSeconds(startedAt);

  // Lightbox state: which check's screenshot is open
  const [openCheck, setOpenCheck] = useState<ScreeningCheck | null>(null);

  // Group completed checks by category for visual grouping.
  // Categories ordered roughly by importance for an AML reviewer's eye.
  const grouped = useMemo(() => {
    const order = [
      "sanctions",
      "pep",
      "adverse_media",
      "company_registry",
      "tax_risk",
    ] as const;
    const byCat: Record<string, ScreeningCheck[]> = {};
    for (const c of phase.checks) {
      const key = c.category || "other";
      if (!byCat[key]) byCat[key] = [];
      byCat[key].push(c);
    }
    // Stable order: known categories first (in `order`), then any unknown
    const keys = [
      ...order.filter((k) => byCat[k]?.length),
      ...Object.keys(byCat).filter((k) => !(order as readonly string[]).includes(k)),
    ];
    return keys.map((k) => ({ category: k, checks: byCat[k] }));
  }, [phase.checks]);

  return (
    <div className="space-y-6">
      {/* Sticky-top status — counter + elapsed + active source */}
      <div className="sticky top-0 z-10 -mx-6 px-6 py-4 bg-background/95 backdrop-blur-sm border-b border-border">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-emerald-600 dark:text-emerald-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {done} / {total} checks complete
              <span className="ml-2 text-muted-foreground font-normal">
                · {formatElapsed(elapsedSec)} elapsed
              </span>
            </p>
            <p className="text-xs text-muted-foreground truncate">
              {phase.latest
                ? `Checking ${phase.latest.database_name}…`
                : "Spinning up the engine…"}
            </p>
          </div>
        </div>
        <div className="mt-3 h-1.5 w-full bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-emerald-600 dark:bg-emerald-500 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Sub-line context — only visible until at least one check lands */}
      {phase.checks.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground leading-relaxed">
          Typical run takes 60–120 seconds. The engine checks 7 international
          sources and captures an evidence screenshot for each. Results expire
          after 24 hours.
        </div>
      )}

      {/* Waterfall — completed checks with screenshots, grouped by category */}
      {grouped.length > 0 && (
        <div className="space-y-6">
          {grouped.map(({ category, checks }) => (
            <div key={category} className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {formatCategory(category)}
              </h2>
              <div className="space-y-2">
                {checks.map((check) => (
                  <CheckRow
                    key={check.id}
                    check={check}
                    onOpenScreenshot={() => setOpenCheck(check)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Lightbox */}
      {openCheck && (
        <ScreenshotLightbox
          check={openCheck}
          onClose={() => setOpenCheck(null)}
        />
      )}
    </div>
  );
}

function CheckRow({
  check,
  onOpenScreenshot,
}: {
  check: ScreeningCheck;
  onOpenScreenshot: () => void;
}) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const thumbUrl = check.screenshot_path
    ? `${supabaseUrl}/storage/v1/object/public/evidence-screenshots/${check.screenshot_path}`
    : null;
  const rateLimited = isRateLimited(check);

  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-muted/40">
      {/* Thumbnail (or placeholder) */}
      {thumbUrl ? (
        <button
          type="button"
          onClick={onOpenScreenshot}
          className="relative shrink-0 w-20 h-14 sm:w-28 sm:h-16 rounded-md overflow-hidden border border-border bg-muted group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Open evidence screenshot for ${check.database_name}`}
        >
          <Image
            src={thumbUrl}
            alt={`Source page for ${check.database_name}`}
            fill
            sizes="(max-width: 640px) 80px, 112px"
            className="object-cover object-top transition-transform duration-200 group-hover:scale-105"
            unoptimized
          />
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>
      ) : (
        <div className="shrink-0 w-20 h-14 sm:w-28 sm:h-16 rounded-md border border-border bg-muted flex items-center justify-center text-muted-foreground">
          <Camera className="w-4 h-4" />
        </div>
      )}

      {/* Source + category */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{check.database_name}</p>
        {check.source_url ? (
          <a
            href={check.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground hover:text-foreground truncate inline-block max-w-full transition-colors"
          >
            {check.source_url}
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">{formatCategory(check.category)}</p>
        )}
      </div>

      {/* Status chip */}
      <StatusChip status={check.status} rateLimited={rateLimited} />
    </div>
  );
}

function ScreenshotLightbox({
  check,
  onClose,
}: {
  check: ScreeningCheck;
  onClose: () => void;
}) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const url = check.screenshot_path
    ? `${supabaseUrl}/storage/v1/object/public/evidence-screenshots/${check.screenshot_path}`
    : "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  if (!url) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Evidence: ${check.database_name}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 sm:p-8"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute top-4 right-4 rounded-full bg-white/10 hover:bg-white/20 text-white p-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Close evidence viewer"
      >
        <X className="w-5 h-5" />
      </button>
      <figure
        onClick={(e) => e.stopPropagation()}
        className="max-w-6xl w-full max-h-full flex flex-col items-center gap-4"
      >
        {/* Using a plain img + unoptimized for Supabase URLs (next/image config
            scope-creeps into next.config; lightbox is interactive so deferring
            optimisation is fine here). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={`Source page for ${check.database_name}`}
          className="max-w-full max-h-[80vh] w-auto h-auto object-contain rounded-lg shadow-2xl bg-white"
        />
        <figcaption className="text-center text-sm text-slate-200 max-w-2xl">
          <p className="font-medium">{check.database_name}</p>
          <p className="text-xs text-slate-400 mt-1">
            {formatCategory(check.category)}
            {check.checked_at
              ? ` · captured ${new Date(check.checked_at).toLocaleString()}`
              : ""}
          </p>
        </figcaption>
      </figure>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function formatCategory(cat: string): string {
  switch (cat) {
    case "sanctions": return "Sanctions";
    case "pep": return "Politically exposed persons";
    case "adverse_media": return "Adverse media";
    case "company_registry": return "Company registry";
    case "tax_risk": return "Tax risk";
    default: return cat.replace(/_/g, " ");
  }
}

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function useStartedAt(): number {
  // Lazy initial state — Date.now() is called once at mount, never during
  // re-renders. Satisfies react-hooks/purity (initial-state callbacks are
  // allowed to be impure because they run exactly once).
  const [startedAt] = useState<number>(() => Date.now());
  return startedAt;
}

function useElapsedSeconds(startedAt: number): number {
  const [now, setNow] = useState<number>(() => startedAt);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function StatusChip({
  status,
  rateLimited,
}: {
  status: CheckStatus;
  rateLimited?: boolean;
}) {
  if (rateLimited) {
    return (
      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/30 shrink-0">
        Source unavailable
      </span>
    );
  }
  const styles: Record<CheckStatus, string> = {
    clear: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
    hit: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/30",
    uncertain: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30",
    error: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/30",
    pending: "bg-muted text-muted-foreground border-border",
  };
  const labels: Record<CheckStatus, string> = {
    clear: "Clear",
    hit: "Hit",
    uncertain: "Review",
    error: "Error",
    pending: "Pending",
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border shrink-0 ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

function StalledBanner({ runAnotherHref }: { runAnotherHref: string }) {
  return (
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-6 space-y-3">
      <div className="flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
        <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
          This screening took longer than expected
        </p>
      </div>
      <p className="text-sm text-amber-900/80 dark:text-amber-100/80">
        A source may be rate-limiting the engine, or the request was
        interrupted. Running another screening will queue cleanly — your
        original attempt counted toward today&apos;s trial limit.
      </p>
      <Link
        href={runAnotherHref}
        className="inline-flex items-center gap-1 h-9 px-3 rounded-md border border-amber-500/30 bg-card hover:bg-amber-500/10 text-sm font-medium transition-colors"
      >
        Run another
        <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  );
}

function ErrorBanner({
  message,
  runAnotherHref,
}: {
  message: string;
  runAnotherHref: string;
}) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-6 space-y-3">
      <div className="flex items-center gap-3">
        <AlertCircle className="w-5 h-5 text-destructive" />
        <p className="text-sm font-medium">Something went wrong</p>
      </div>
      <p className="text-sm text-muted-foreground">{message}</p>
      <Link
        href={runAnotherHref}
        className="inline-flex items-center gap-1 h-9 px-3 rounded-md border border-border bg-card hover:bg-muted text-sm font-medium transition-colors"
      >
        Run another
        <ArrowRight className="w-4 h-4" />
      </Link>
    </div>
  );
}

/**
 * B-UI — post-result signup nudge. Reads `?left=<remaining>` (set by the hero
 * form on submit) and surfaces the free-search count as real content, not a
 * bare status badge: a primary "save + sign in" carrot whose body line carries
 * the live count, plus the book-a-call CTA. `left > 0` → "N free searches left
 * today"; `left === 0` (or absent) → "last free search".
 */
function PostResultCallouts({ copy }: { copy: ResultCopy }) {
  const searchParams = useSearchParams();
  const leftParam = searchParams.get("left");
  const left = leftParam !== null ? Number.parseInt(leftParam, 10) : null;
  const hasLeft = left !== null && Number.isFinite(left) && left > 0;

  // freeLeftTemplate is already plural-resolved server-side against ?left=;
  // the client only chooses between the count line and the last-free line.
  const freeSearchLine = hasLeft ? copy.freeLeftTemplate : copy.lastFree;

  return (
    <div className="space-y-3">
      {/* Free-search count as content — differentiated weight: a filled accent
          banner, not a muted badge. */}
      <div
        className={`flex items-start gap-3 rounded-lg border p-4 ${
          hasLeft
            ? "border-emerald-500/30 bg-emerald-500/10"
            : "border-amber-500/40 bg-amber-500/10"
        }`}
      >
        <Sparkles
          className={`w-5 h-5 mt-0.5 shrink-0 ${
            hasLeft
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-amber-600 dark:text-amber-400"
          }`}
        />
        <p
          className={`text-sm font-medium ${
            hasLeft
              ? "text-emerald-900 dark:text-emerald-100"
              : "text-amber-900 dark:text-amber-100"
          }`}
        >
          {freeSearchLine}
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <Link
          href="/login"
          className="flex items-start gap-3 p-4 rounded-lg border border-border bg-card hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Sparkles className="w-5 h-5 text-primary mt-0.5" />
          <div>
            <p className="text-sm font-medium">{copy.saveResultTitle}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {copy.saveResultBody}
            </p>
          </div>
        </Link>
        <a
          href={BOOKING_URL}
          target={BOOKING_URL.startsWith("http") ? "_blank" : undefined}
          rel={BOOKING_URL.startsWith("http") ? "noopener noreferrer" : undefined}
          className="flex items-start gap-3 p-4 rounded-lg border border-border bg-card hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Calendar className="w-5 h-5 text-primary mt-0.5" />
          <div>
            <p className="text-sm font-medium">{copy.bookDemoTitle}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {copy.bookDemoBody}
            </p>
          </div>
        </a>
      </div>
    </div>
  );
}
