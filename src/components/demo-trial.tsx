"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Calendar,
  Loader2,
  Search,
  Shield,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { ScreeningViewer } from "./screening-viewer";
import type { Screening, ScreeningCheck } from "@/lib/types";

/**
 * Public unauth trial UI. Owns the state machine: idle → running → done.
 *
 * The form submits to /api/demo/run, which creates an `is_demo=true` row + fires
 * the engine. Polling /api/demo/[id]/status returns progress; once the row hits
 * `completed`, we fetch the full result via /api/demo/[id]/checks and hand it
 * to <ScreeningViewer demoMode={true} /> for rendering — same component the
 * dashboard uses, so the visitor sees the real product surface.
 *
 * Result-page CTAs:
 *   - "Sign in to save this result + run more"  → /login (the conversion path
 *     a research-mode visitor was avoiding before; it's now an opt-in carrot,
 *     not a gate)
 *   - "Book a 20-min demo"  → BOOKING_URL  (the validation-week conversion
 *     path that was missing entirely from the prior page)
 *
 * Composes with LR-WS-2026-029: the engine defaults to `uncertain`, never
 * `clear`. The result UI surfaces uncertain checks prominently so a visitor
 * can verify the dual-affirmative invariant on a name they pick — that's the
 * audit-wedge made visible.
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
}

interface ChecksResponse {
  screening: Screening;
  checks: ScreeningCheck[];
}

type Phase =
  | { kind: "idle" }
  | { kind: "submitting" }
  | {
      kind: "running";
      screeningId: string;
      done: number;
      total: number;
      latest: StatusResponse["latest_check"];
    }
  | { kind: "stalled"; screeningId: string }
  | { kind: "done"; screening: Screening; checks: ScreeningCheck[] }
  | { kind: "error"; message: string };

export function DemoTrial() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState<"individual" | "company">(
    "individual"
  );
  const [remaining, setRemaining] = useState<number | null>(null);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!name.trim()) return;
      setPhase({ kind: "submitting" });
      try {
        const res = await fetch("/api/demo/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim(), entityType }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 429) {
            setPhase({
              kind: "error",
              message: `Daily trial limit reached. Sign in to run more screenings, or come back tomorrow.`,
            });
          } else {
            setPhase({
              kind: "error",
              message: data.error || `Request failed (HTTP ${res.status})`,
            });
          }
          return;
        }
        setRemaining(typeof data.remaining === "number" ? data.remaining : null);
        setPhase({
          kind: "running",
          screeningId: data.screeningId,
          done: 0,
          total: data.totalChecks ?? 0,
          latest: null,
        });
      } catch (err) {
        setPhase({
          kind: "error",
          message:
            err instanceof Error ? err.message : "Failed to start screening",
        });
      }
    },
    [name, entityType]
  );

  // Polling effect — runs while phase.kind === "running"
  const pollStartRef = useRef<number>(0);
  useEffect(() => {
    if (phase.kind !== "running") return;
    pollStartRef.current = Date.now();
    const screeningId = phase.screeningId;

    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const res = await fetch(`/api/demo/${screeningId}/status`);
        if (!res.ok) return; // transient — retry next interval
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
          if (!cancelled) setPhase({ kind: "stalled", screeningId });
          return;
        }
        if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
          if (!cancelled) setPhase({ kind: "stalled", screeningId });
          return;
        }
        if (!cancelled) {
          setPhase(prev =>
            prev.kind === "running"
              ? {
                  ...prev,
                  done: data.checks_completed ?? prev.done,
                  total: data.checks_total ?? prev.total,
                  latest: data.latest_check,
                }
              : prev
          );
        }
      } catch {
        // transient — retry
      }
    };

    const interval = setInterval(tick, POLL_INTERVAL_MS);
    void tick(); // immediate first poll so the user doesn't wait 3s for first signal
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [phase]);

  const reset = () => {
    setPhase({ kind: "idle" });
    setName("");
  };

  // ────────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────────

  if (phase.kind === "done") {
    return (
      <div className="space-y-6">
        <PostResultCallouts remaining={remaining} onReset={reset} />
        <ScreeningViewer
          screening={phase.screening}
          checks={phase.checks}
          supabaseUrl={process.env.NEXT_PUBLIC_SUPABASE_URL || ""}
          demoMode={true}
        />
        <PostResultCallouts remaining={remaining} onReset={reset} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="rounded-xl border border-white/10 bg-slate-900/60 p-6 sm:p-8">
        <div className="flex items-start gap-3 mb-4">
          <Sparkles className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-lg font-semibold text-white">
              Run a real screening — no sign-in required
            </h2>
            <p className="mt-1.5 text-sm text-slate-400">
              Type any name. We&apos;ll run it through 7 sources (sanctions, PEP,
              registries, adverse media) and show you the real evidence trail.
              1 free run per day. Sign in to run more.
            </p>
          </div>
        </div>

        {phase.kind === "idle" || phase.kind === "submitting" || phase.kind === "error" ? (
          <form onSubmit={onSubmit} className="space-y-4 mt-6">
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setEntityType("individual")}
                className={`px-3 py-1.5 rounded-md border transition-colors ${
                  entityType === "individual"
                    ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
                    : "border-white/10 text-slate-400 hover:border-white/20"
                }`}
              >
                Individual
              </button>
              <button
                type="button"
                onClick={() => setEntityType("company")}
                className={`px-3 py-1.5 rounded-md border transition-colors ${
                  entityType === "company"
                    ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
                    : "border-white/10 text-slate-400 hover:border-white/20"
                }`}
              >
                Company
              </button>
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                <input
                  type="text"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder={
                    entityType === "individual"
                      ? "e.g. Pjotrs Avens"
                      : "e.g. AS Air Baltic Corporation"
                  }
                  maxLength={120}
                  required
                  disabled={phase.kind === "submitting"}
                  className="w-full h-11 pl-9 pr-3 rounded-md bg-slate-800 border border-white/10 text-white placeholder:text-slate-500 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
                />
              </div>
              <button
                type="submit"
                disabled={phase.kind === "submitting" || !name.trim()}
                className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold px-5 h-11 rounded-md transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {phase.kind === "submitting" ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" /> Starting…
                  </>
                ) : (
                  <>
                    Run screening <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
            {phase.kind === "error" && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{phase.message}</span>
              </div>
            )}
            <p className="text-xs text-slate-500 leading-relaxed">
              <Shield className="w-3 h-3 inline -mt-0.5 mr-1 text-emerald-500" />
              Result URLs are public for 24h, then garbage-collected. The engine
              defaults to <code className="text-emerald-400">uncertain</code>,
              never <code className="text-emerald-400">clear</code> — silent
              false-clears are a contract violation, not a quiet bug.
            </p>
          </form>
        ) : null}

        {phase.kind === "running" ? (
          <RunningProgress phase={phase} />
        ) : null}

        {phase.kind === "stalled" ? (
          <div className="mt-6 rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="text-sm text-amber-300">
              The screening took longer than expected. The engine may have hit a
              source-side rate limit. Try again, or sign in to retry without
              counting against your daily quota.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={reset}
                className="text-xs px-3 py-1.5 rounded-md border border-white/15 hover:border-emerald-500/50 hover:text-emerald-400 transition-colors"
              >
                Run another
              </button>
              <Link
                href="/login"
                className="text-xs px-3 py-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/20 transition-colors"
              >
                Sign in
              </Link>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RunningProgress({
  phase,
}: {
  phase: Extract<Phase, { kind: "running" }>;
}) {
  const pct =
    phase.total > 0 ? Math.min(100, Math.round((phase.done / phase.total) * 100)) : 0;
  return (
    <div className="mt-6 space-y-3">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 text-slate-300">
          <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
          <span>Running screening…</span>
        </div>
        <span className="text-xs text-slate-500 tabular-nums">
          {phase.done} / {phase.total || "?"} checks
        </span>
      </div>
      <div className="h-1.5 w-full bg-slate-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-emerald-500 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      {phase.latest ? (
        <p className="text-xs text-slate-500">
          Latest: {phase.latest.database_name}{" "}
          <span className="text-slate-600">· {phase.latest.category}</span>
        </p>
      ) : (
        <p className="text-xs text-slate-500">
          Spinning up Playwright + visiting first source…
        </p>
      )}
      <p className="text-[11px] text-slate-600 leading-relaxed">
        First-time runs typically take 60–120 seconds. Each source is visited
        live; results aren&apos;t cached. The browser is stealth-patched so
        sources see a realistic user.
      </p>
    </div>
  );
}

function PostResultCallouts({
  remaining,
  onReset,
}: {
  remaining: number | null;
  onReset: () => void;
}) {
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-emerald-300">
            Want to save this result + run more?
          </h3>
          <p className="mt-1 text-xs text-slate-400 leading-relaxed max-w-md">
            Sign in to retain results, generate the LV Bar Council annexes (P2 /
            P3.1 / P3.2), and download a signed PDF + DOCX bundle.
            {remaining !== null && remaining > 0
              ? ` ${remaining} free trial run${remaining === 1 ? "" : "s"} left today.`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/login"
            className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-sm px-4 py-2 rounded-md transition-colors"
          >
            Sign in <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          <a
            href={BOOKING_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 border border-emerald-500/40 hover:bg-emerald-500/10 text-emerald-300 text-sm px-4 py-2 rounded-md transition-colors"
          >
            <Calendar className="w-3.5 h-3.5" />
            Book a 20-min demo
          </a>
          <button
            onClick={onReset}
            className="inline-flex items-center gap-2 text-slate-400 hover:text-white text-sm px-4 py-2 transition-colors"
          >
            Run another
          </button>
        </div>
      </div>
    </div>
  );
}
