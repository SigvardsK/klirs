"use client";

import { useEffect, useState, useCallback } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Shield, Camera, Table, FileText, Clock, CheckCircle, XCircle,
  AlertTriangle, ExternalLink, Building2, User, Loader2, Download, Eye
} from "lucide-react";
import type { Screening, ScreeningCheck } from "@/lib/types";
import { statusDisplayLabel } from "@/lib/types";
import { SEARCHABLE_DATABASES, ADVERSE_MEDIA_CONFIG, COMPANY_REGISTRY_CONFIG } from "@/lib/db-configs";
import { deriveRisk, type RiskLevel } from "@/lib/risk-score";
import { expandLvVariants } from "@/lib/name-variants";
import { ANNEX_META, resolveVariants, type AnnexVariant } from "@/lib/annex/variants";
import { AnnexPreviewModal } from "@/components/annex-preview-modal";

interface Props {
  screening: Screening;
  checks: ScreeningCheck[];
  supabaseUrl: string;
  demoMode?: boolean;
  reviewerName?: string;
}

const categoryLabels: Record<string, string> = {
  sanctions: "Sanctions",
  pep: "PEP / Officials",
  adverse_media: "Adverse Media",
  company_registry: "Company Registry",
  tax_risk: "Tax Risk",
};

const statusColors: Record<string, string> = {
  clear: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  hit: "bg-red-500/10 text-red-400 border-red-500/20",
  uncertain: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  error: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  pending: "bg-slate-500/10 text-slate-400 border-slate-500/20",
};

// VID PNP + VID VAD submit POST forms and render results in place — the
// captured source_url is the service landing, not a reproducible result. We
// still show the URL (it's the audit trail) but with a caveat.
function isLandingOnlyUrl(databaseName: string): boolean {
  return databaseName.startsWith("VID ");
}

// Client-side download — fetches the public Supabase Storage URL, turns it into
// a blob, and triggers a named attachment. Keeps the download flow purely in
// the browser; no server route required.
async function downloadScreenshot(url: string, filename: string): Promise<void> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    const blob = await r.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  } catch (err) {
    console.error("Screenshot download failed:", err);
  }
}

function slugifyForFilename(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

// Build expected check list for progress display. Mirrors the engine's fan-out
// (primary name + aliases + LV-transliteration variants from expandLvVariants)
// so the live progress list matches what actually runs.
function buildExpectedChecks(screening: Screening): { dbName: string; searchTerm: string; category: string }[] {
  const expected: { dbName: string; searchTerm: string; category: string }[] = [];
  const personVariants = (screening.persons || [])
    .filter(p => p.name.trim())
    .flatMap(p => {
      const primary = p.name.trim();
      const aliases = (p.aliases || [])
        .map(a => a.trim())
        .filter(a => a.length > 0 && a !== primary);
      const explicit = [primary, ...Array.from(new Set(aliases))];
      const expanded = new Set<string>();
      for (const v of explicit) {
        for (const e of expandLvVariants(v)) expanded.add(e);
      }
      return Array.from(expanded);
    });

  // Company name fan-out (mirror engine's companyVariants).
  const companyVariants = screening.entity_name.trim()
    ? expandLvVariants(screening.entity_name)
    : [];

  for (const db of SEARCHABLE_DATABASES) {
    if (db.personsOnly) {
      for (const variant of personVariants) {
        expected.push({ dbName: db.name, searchTerm: variant, category: db.category });
      }
    } else if (screening.entity_type === "individual") {
      // Individual entity: skip the company slot — engine does too.
      for (const variant of personVariants) {
        expected.push({ dbName: db.name, searchTerm: variant, category: db.category });
      }
    } else {
      for (const cv of companyVariants) {
        expected.push({ dbName: db.name, searchTerm: cv, category: db.category });
      }
      for (const variant of personVariants) {
        expected.push({ dbName: db.name, searchTerm: variant, category: db.category });
      }
    }
  }

  // Adverse media: each variant × 4 languages
  const languages = ["LV", "EN", "ET", "RU"];
  for (const variant of personVariants) {
    for (const lang of languages) {
      expected.push({ dbName: `Adverse Media (${lang})`, searchTerm: `${variant} (${lang})`, category: "adverse_media" });
    }
  }

  // Company registry (3 checks: search results + company detail + persons tab).
  // Use reg number if provided (mirrors engine behaviour) so the live progress
  // list shows the term the engine will actually search for.
  if (screening.entity_type === "company") {
    const urSearchTerm = screening.registration_number?.trim() || screening.entity_name;
    expected.push({ dbName: `${COMPANY_REGISTRY_CONFIG.name} — Search`, searchTerm: urSearchTerm, category: "company_registry" });
    expected.push({ dbName: `${COMPANY_REGISTRY_CONFIG.name} — Detail`, searchTerm: urSearchTerm, category: "company_registry" });
    expected.push({ dbName: `${COMPANY_REGISTRY_CONFIG.name} — Persons`, searchTerm: urSearchTerm, category: "company_registry" });
  }

  return expected;
}

// Set of strings the user explicitly typed: entity_name + each person's name +
// each person's aliases. A check whose `search_term` is NOT in this set came
// from the LV-transliteration auto-expansion. The Checks tab labels those with
// a `(auto-variant)` badge so the lawyer can audit what was actually searched.
function buildOriginalsSet(screening: Screening): Set<string> {
  const originals = new Set<string>();
  if (screening.entity_name.trim()) originals.add(screening.entity_name.trim());
  for (const p of screening.persons || []) {
    if (p.name.trim()) originals.add(p.name.trim());
    for (const a of p.aliases || []) {
      if (a.trim()) originals.add(a.trim());
    }
  }
  return originals;
}

// Adverse-media check rows have search_term in the form `<name> (<lang>)`.
// Strip the language suffix before comparing against the originals set.
function stripLangSuffix(searchTerm: string): string {
  return searchTerm.replace(/\s*\((LV|EN|ET|RU)\)\s*$/, "").trim();
}

export function ScreeningViewer({ screening: initialScreening, checks: initialChecks, supabaseUrl, demoMode = false, reviewerName = "" }: Props) {
  const [screening, setScreening] = useState(initialScreening);
  const [checks, setChecks] = useState(initialChecks);
  const [selectedScreenshot, setSelectedScreenshot] = useState<ScreeningCheck | null>(null);
  const [annexReviewer, setAnnexReviewer] = useState(reviewerName);
  const [openAnnex, setOpenAnnex] = useState<AnnexVariant | null>(null);
  // Stalled state is synthetic (computed by /status) — not stored on the Screening
  // row. When true, the runner has been silent for >5min; UI offers Retry.
  const [stalled, setStalled] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const isActive = demoMode ? false : (screening.status === "pending" || screening.status === "in_progress");

  const fetchStatus = useCallback(async () => {
    if (demoMode) return;
    const res = await fetch(`/api/screenings/${screening.id}/status`);
    if (res.ok) {
      const data = await res.json();
      // /status returns synthetic `status: "stalled"` for stuck rows; the real
      // row status lives in `raw_status`. Preserve raw_status on the Screening
      // type so badge logic / completed-detection still work.
      const rawStatus = data.raw_status || data.status;
      setScreening(prev => ({
        ...prev,
        status: rawStatus,
        checks_completed: data.checks_completed,
        checks_total: data.checks_total,
        completed_at: data.completed_at,
      }));
      setStalled(data.status === "stalled" || !!data.recoverable);
    }
  }, [screening.id, demoMode]);

  useEffect(() => {
    if (demoMode || !isActive) return;
    if (stalled) return; // Stop polling once we've concluded the runner is dead.
    const interval = setInterval(async () => {
      await fetchStatus();
      const checksRes = await fetch(`/api/screenings/${screening.id}/checks`);
      if (checksRes.ok) {
        const checksData = await checksRes.json();
        setChecks(checksData);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [isActive, stalled, screening.id, fetchStatus, demoMode]);

  // On first mount: poll /status once so we surface stalled state for screenings
  // that were already dead before the user opened the page.
  useEffect(() => {
    if (demoMode) return;
    fetchStatus();
  }, [fetchStatus, demoMode]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/screenings/${screening.id}/retry`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      // Reset local state — checks are wiped server-side, and status flips to pending.
      setChecks([]);
      setStalled(false);
      setScreening(prev => ({
        ...prev,
        status: "pending",
        checks_completed: 0,
        checks_total: 0,
        completed_at: null,
      }));
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  }, [screening.id]);

  useEffect(() => {
    if (demoMode) return;
    if (screening.status === "completed" && checks.length === 0) {
      window.location.reload();
    }
  }, [screening.status, checks.length, demoMode]);

  const progress = screening.checks_total > 0
    ? (screening.checks_completed / screening.checks_total) * 100
    : 0;

  const screenshotUrl = (path: string) =>
    `${supabaseUrl}/storage/v1/object/public/evidence-screenshots/${path}`;

  const checksByCategory = checks.reduce<Record<string, ScreeningCheck[]>>((acc, check) => {
    const cat = check.category;
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(check);
    return acc;
  }, {});

  const expectedChecks = buildExpectedChecks(screening);
  const completedDbNames = new Set(checks.map(c => `${c.database_name}|${c.search_term}`));
  const originalTerms = buildOriginalsSet(screening);

  // Status counts (for summary chips).
  const clearCount = checks.filter(c => c.status === "clear").length;
  const hitCount = checks.filter(c => c.status === "hit").length;
  const uncertainCount = checks.filter(c => c.status === "uncertain").length;
  const errorCount = checks.filter(c => c.status === "error").length;

  // Category-weighted risk derivation — see src/lib/risk-score.ts for the rule set.
  const risk = deriveRisk(checks);
  const riskColorByLevel: Record<RiskLevel, string> = {
    "LOW": "text-emerald-400",
    "LOW-MEDIUM": "text-lime-400",
    "MEDIUM": "text-amber-400",
    "HIGH": "text-orange-400",
    "REJECT": "text-red-500",
  };
  const riskBarByLevel: Record<RiskLevel, string> = {
    "LOW": "bg-emerald-500",
    "LOW-MEDIUM": "bg-lime-500",
    "MEDIUM": "bg-amber-500",
    "HIGH": "bg-orange-500",
    "REJECT": "bg-red-500",
  };
  const riskBadgeByLevel: Record<RiskLevel, string> = {
    "LOW": statusColors.clear,
    "LOW-MEDIUM": "bg-lime-500/10 text-lime-400 border-lime-500/20",
    "MEDIUM": statusColors.uncertain,
    "HIGH": "bg-orange-500/10 text-orange-400 border-orange-500/20",
    "REJECT": statusColors.hit,
  };
  const riskColor = riskColorByLevel[risk.level];

  return (
    <div>
      {/* Header */}
      <div className="bg-slate-900 rounded-xl border border-white/10 p-6 mb-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            {screening.entity_type === "company" ? (
              <Building2 className="w-8 h-8 text-emerald-500" />
            ) : (
              <User className="w-8 h-8 text-emerald-500" />
            )}
            <div>
              <h1 className="text-xl font-bold text-white">{screening.entity_name}</h1>
              <p className="text-sm text-slate-400">
                {screening.entity_type === "company" ? "Company" : "Individual"}
                {" · "}{screening.jurisdiction}
                {screening.registration_number && ` · ${screening.registration_number}`}
                {screening.persons?.length > 0 && ` · ${screening.persons.length} person(s)`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {screening.status === "completed" && !demoMode && (
              <a
                href={`/api/screenings/${screening.id}/export.pdf`}
                className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition-colors"
              >
                <FileText className="w-3.5 h-3.5" />
                Export PDF
              </a>
            )}
            <Badge className={
              screening.status === "completed" ? statusColors.clear :
              screening.status === "failed" ? statusColors.error :
              "bg-blue-500/10 text-blue-400 border-blue-500/20"
            }>
              {screening.status === "in_progress" ? "Screening..." :
               screening.status.charAt(0).toUpperCase() + screening.status.slice(1)}
            </Badge>
          </div>
        </div>

        {/* Progress bar */}
        {isActive && (
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
              <span>{screening.checks_completed} / {screening.checks_total} database checks complete</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <Progress value={progress} className="h-2 bg-slate-800" />
          </div>
        )}

        {screening.status === "completed" && (
          <div className="mt-4 flex items-center gap-4 text-sm text-slate-400">
            <span className="flex items-center gap-1">
              <CheckCircle className="w-4 h-4 text-emerald-500" />
              {screening.checks_completed} checks completed
            </span>
            <span className="text-emerald-400">{clearCount} clear</span>
            <span className="text-red-400">{hitCount} hit</span>
            <span className="text-amber-400">{uncertainCount} to review</span>
            <span className="text-orange-400">{errorCount} error</span>
          </div>
        )}

        {/* Stalled banner — runner has been silent for >5min. The fire-and-forget
            background promise died (likely OOM / process recycle on Railway).
            Wipe partial state and re-run from the same submission. */}
        {stalled && !demoMode && (
          <div className="mt-4 flex items-start gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm text-amber-300 font-medium">Screening was interrupted</p>
              <p className="text-xs text-slate-400 mt-1">
                The background runner stopped responding (last activity {">"} 5 min ago).
                {screening.checks_completed > 0 && ` ${screening.checks_completed} of ${screening.checks_total} checks completed before the interruption.`}
                {" "}Click Retry to re-run from scratch — partial results will be discarded.
              </p>
              {retryError && (
                <p className="text-xs text-red-400 mt-1">Retry failed: {retryError}</p>
              )}
            </div>
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              className="text-xs px-3 py-1.5 rounded-md bg-amber-500/20 text-amber-200 border border-amber-500/30 hover:bg-amber-500/30 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            >
              {retrying ? "Retrying..." : "Retry screening"}
            </button>
          </div>
        )}
      </div>

      {/* Live Progress Steps — shown during active screening */}
      {isActive && (
        <div className="bg-slate-900 rounded-xl border border-white/10 p-5 mb-6">
          <h3 className="text-sm font-semibold text-slate-300 mb-4 uppercase tracking-wider">Live Progress</h3>
          <div className="space-y-2">
            {expectedChecks.map((expected, i) => {
              const key = `${expected.dbName}|${expected.searchTerm}`;
              const completed = completedDbNames.has(key);
              const isNext = !completed && i === checks.length;
              const matchedCheck = checks.find(c => c.database_name === expected.dbName && c.search_term === expected.searchTerm);

              return (
                <div key={i} className={`flex items-center gap-3 py-1.5 px-3 rounded-lg transition-colors ${
                  isNext ? "bg-blue-500/5 border border-blue-500/20" : ""
                }`}>
                  {/* Status icon */}
                  {completed ? (
                    matchedCheck?.status === "error" ? (
                      <XCircle className="w-4 h-4 text-orange-500 shrink-0" />
                    ) : matchedCheck?.status === "hit" ? (
                      <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                    ) : matchedCheck?.status === "uncertain" ? (
                      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                    ) : (
                      <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />
                    )
                  ) : isNext ? (
                    <Loader2 className="w-4 h-4 text-blue-400 shrink-0 animate-spin" />
                  ) : (
                    <div className="w-4 h-4 rounded-full border border-slate-600 shrink-0" />
                  )}

                  {/* Database name + search term */}
                  <div className="flex-1 min-w-0">
                    <span className={`text-sm ${completed ? "text-slate-400" : isNext ? "text-blue-300 font-medium" : "text-slate-600"}`}>
                      {expected.dbName}
                    </span>
                    <span className="text-xs text-slate-600 ml-2">
                      {expected.searchTerm}
                    </span>
                  </div>

                  {/* Status label */}
                  {completed && matchedCheck && (
                    <span className={`text-xs ${
                      matchedCheck.status === "clear" ? "text-emerald-500" :
                      matchedCheck.status === "hit" ? "text-red-400" :
                      matchedCheck.status === "uncertain" ? "text-amber-400" :
                      "text-orange-400"
                    }`}>
                      {statusDisplayLabel(matchedCheck.status)}
                    </span>
                  )}
                  {isNext && (
                    <span className="text-xs text-blue-400">checking...</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Persons list */}
      {screening.persons?.length > 0 && (
        <div className="bg-slate-900/50 rounded-xl border border-white/10 p-4 mb-6">
          <h3 className="text-sm font-medium text-slate-300 mb-2">Screened Persons</h3>
          <div className="flex flex-wrap gap-2">
            {screening.persons.map((person, i) => (
              <Badge key={i} variant="secondary" className="bg-slate-800 text-slate-300 border-white/10">
                {person.name}
                {person.role && <span className="text-slate-500 ml-1">({person.role})</span>}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Tabs */}
      <Tabs defaultValue={demoMode ? "analysis" : isActive ? "checks" : "screenshots"} className="w-full">
        <TabsList className="bg-slate-900 border border-white/10 mb-6">
          {!demoMode && (
            <TabsTrigger value="screenshots" className="data-[state=active]:bg-slate-800 gap-1.5">
              <Camera className="w-4 h-4" />
              Screenshots
            </TabsTrigger>
          )}
          <TabsTrigger value="checks" className="data-[state=active]:bg-slate-800 gap-1.5">
            <Table className="w-4 h-4" />
            Checks
          </TabsTrigger>
          <TabsTrigger value="analysis" className="data-[state=active]:bg-slate-800 gap-1.5">
            <FileText className="w-4 h-4" />
            Analysis
          </TabsTrigger>
        </TabsList>

        {/* Screenshots Tab */}
        <TabsContent value="screenshots">
          {checks.length === 0 ? (
            <div className="bg-slate-900 rounded-xl border border-white/10 p-8 text-center">
              <Clock className="w-8 h-8 text-blue-400 mx-auto mb-3 animate-pulse" />
              <p className="text-slate-400">Screenshots will appear here as checks complete...</p>
            </div>
          ) : (
            <div className="space-y-6">
              {Object.entries(checksByCategory).map(([category, categoryChecks]) => (
                <div key={category}>
                  <h3 className="text-sm font-semibold text-slate-300 mb-3 uppercase tracking-wider">
                    {categoryLabels[category] || category}
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {categoryChecks.filter(c => c.screenshot_path).map((check) => (
                      <div
                        key={check.id}
                        className="bg-slate-900 rounded-lg border border-white/10 overflow-hidden cursor-pointer hover:border-emerald-500/30 transition-colors"
                        onClick={() => setSelectedScreenshot(check)}
                      >
                        <div className="aspect-video bg-slate-800 relative">
                          <img
                            src={screenshotUrl(check.screenshot_path!)}
                            alt={`${check.database_name} - ${check.search_term}`}
                            className="w-full h-full object-cover object-top"
                            loading="lazy"
                          />
                          <Badge className={`absolute top-2 right-2 text-xs ${statusColors[check.status]}`}>
                            {check.status}
                          </Badge>
                        </div>
                        <div className="p-3">
                          <p className="text-sm font-medium text-white truncate">{check.database_name}</p>
                          <p className="text-xs text-slate-500 truncate">{check.search_term}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {selectedScreenshot && (
            <div
              className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
              onClick={() => setSelectedScreenshot(null)}
            >
              <div className="max-w-5xl max-h-[90vh] overflow-auto flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
                <img
                  src={screenshotUrl(selectedScreenshot.screenshot_path!)}
                  alt="Evidence screenshot"
                  className="w-full rounded-lg"
                />
                {selectedScreenshot.source_url && (
                  <div className="bg-slate-900/90 border border-white/10 rounded-lg px-4 py-3 flex items-center gap-2 text-xs">
                    <span className="text-slate-500 shrink-0">Source:</span>
                    <a
                      href={selectedScreenshot.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-emerald-400 hover:text-emerald-300 truncate"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {selectedScreenshot.source_url}
                    </a>
                    <ExternalLink className="w-3 h-3 text-slate-500 shrink-0" />
                  </div>
                )}
              </div>
            </div>
          )}
        </TabsContent>

        {/* Checks Tab */}
        <TabsContent value="checks">
          <div className="bg-slate-900 rounded-xl border border-white/10 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left text-xs font-medium text-slate-400 p-3">Database</th>
                  <th className="text-left text-xs font-medium text-slate-400 p-3">Category</th>
                  <th className="text-left text-xs font-medium text-slate-400 p-3">Search Term</th>
                  <th className="text-left text-xs font-medium text-slate-400 p-3">Status</th>
                  <th className="text-left text-xs font-medium text-slate-400 p-3">Source</th>
                  <th className="text-left text-xs font-medium text-slate-400 p-3">Screenshot</th>
                  <th className="text-left text-xs font-medium text-slate-400 p-3">Time</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((check) => (
                  <tr key={check.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="p-3 text-sm text-white">{check.database_name}</td>
                    <td className="p-3">
                      <Badge variant="secondary" className="text-xs bg-slate-800 text-slate-300 border-white/10">
                        {categoryLabels[check.category] || check.category}
                      </Badge>
                    </td>
                    <td className="p-3 text-sm text-slate-400">
                      {check.search_term}
                      {!originalTerms.has(stripLangSuffix(check.search_term)) && (
                        <span
                          className="ml-2 inline-block text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 align-middle"
                          title="Auto-derived spelling variant — engine searched this in addition to what you typed."
                        >
                          auto-variant
                        </span>
                      )}
                    </td>
                    <td className="p-3">
                      <Badge className={`text-xs ${statusColors[check.status]}`}>
                        {check.status === "clear" && <CheckCircle className="w-3 h-3 mr-1" />}
                        {check.status === "hit" && <AlertTriangle className="w-3 h-3 mr-1" />}
                        {check.status === "uncertain" && <AlertTriangle className="w-3 h-3 mr-1" />}
                        {check.status === "error" && <XCircle className="w-3 h-3 mr-1" />}
                        {statusDisplayLabel(check.status)}
                      </Badge>
                    </td>
                    <td className="p-3">
                      {check.source_url ? (
                        <div className="flex flex-col gap-0.5">
                          <a
                            href={check.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"
                            title={check.source_url}
                          >
                            open
                            <ExternalLink className="w-3 h-3" />
                          </a>
                          {isLandingOnlyUrl(check.database_name) && (
                            <span className="text-[10px] text-slate-600 italic" title="VID services use POST submission; the URL opens the search form, not the result. See the screenshot for the captured result.">
                              search form — see screenshot
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-600">—</span>
                      )}
                    </td>
                    <td className="p-3">
                      {check.screenshot_path ? (
                        <button
                          type="button"
                          onClick={() => downloadScreenshot(
                            screenshotUrl(check.screenshot_path!),
                            `aml-${slugifyForFilename(check.database_name)}-${slugifyForFilename(check.search_term)}.png`
                          )}
                          className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300"
                          title="Download this screenshot as a PNG"
                        >
                          PNG
                          <Download className="w-3 h-3" />
                        </button>
                      ) : (
                        <span className="text-xs text-slate-600">—</span>
                      )}
                    </td>
                    <td className="p-3 text-xs text-slate-500">
                      {check.checked_at ? new Date(check.checked_at).toLocaleTimeString() : "—"}
                    </td>
                  </tr>
                ))}
                {checks.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-500">
                      {isActive ? "Checks will appear here as they complete..." : "No checks recorded"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        {/* Analysis Tab — Demo Sample */}
        <TabsContent value="analysis">
          {/* Banner */}
          <div className={`${demoMode ? "bg-blue-500/10 border-blue-500/30" : "bg-amber-500/10 border-amber-500/30"} border rounded-xl p-4 mb-6 flex items-start gap-3`}>
            {demoMode ? (
              <Shield className="w-5 h-5 text-blue-400 mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
            )}
            <div>
              <p className={`text-sm font-medium ${demoMode ? "text-blue-300" : "text-amber-400"}`}>
                {demoMode ? "Sample Screening Report" : "DEMO — Sample Analysis"}
              </p>
              <p className={`text-xs mt-0.5 ${demoMode ? "text-blue-300/70" : "text-amber-400/70"}`}>
                {demoMode
                  ? "This is a sample report for AS Air Baltic Corporation showing what a completed AML screening looks like. Sign in to run your own screening."
                  : "This is a sample analysis based on your screening results. Contact us for a full risk evaluation with compliance documentation."}
              </p>
            </div>
          </div>

          <div className="space-y-4">
            {/* Risk Score */}
            <div className="bg-slate-900 rounded-xl border border-white/10 p-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-slate-300">Risk Score</h3>
                <div className="flex items-center gap-2">
                  <span className={`text-3xl font-bold ${riskColor}`}>
                    {risk.score}
                  </span>
                  <span className="text-sm text-slate-500">/ 2,500+</span>
                </div>
              </div>
              <div className="h-3 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-1000 ${riskBarByLevel[risk.level]}`}
                  style={{ width: `${Math.max(Math.min((risk.score / 2500) * 100, 100), risk.score > 0 ? 2 : 0)}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-slate-600 mt-2">
                <span className={risk.level === "LOW" ? "text-emerald-400 font-medium" : ""}>LOW (0–40)</span>
                <span className={risk.level === "LOW-MEDIUM" ? "text-lime-400 font-medium" : ""}>LOW-MED (41–150)</span>
                <span className={risk.level === "MEDIUM" ? "text-amber-400 font-medium" : ""}>MED (151–400)</span>
                <span className={risk.level === "HIGH" ? "text-orange-400 font-medium" : ""}>HIGH (401–2000)</span>
                <span className={risk.level === "REJECT" ? "text-red-500 font-medium" : ""}>REJECT (2001+)</span>
              </div>
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <Badge className={riskBadgeByLevel[risk.level]}>
                  {risk.level}
                </Badge>
                {risk.incomplete && (
                  <Badge className={statusColors.error}>
                    INCOMPLETE — {errorCount} check(s) errored
                  </Badge>
                )}
              </div>
            </div>

            {/* Risk Breakdown — transparent per-category contribution */}
            {risk.breakdown.length > 0 && (
              <div className="bg-slate-900 rounded-xl border border-white/10 p-6">
                <h3 className="text-sm font-medium text-slate-300 mb-3">Risk Score Breakdown</h3>
                <p className="text-xs text-slate-500 mb-3">
                  Each category contributes to the score based on confirmed hits and results flagged for review. A sanctions hit escalates directly to the highest classification; adverse-media uncertainty contributes only to the low-medium classification unless paired with stronger signals.
                </p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10">
                      <th className="text-left text-xs font-medium text-slate-400 py-2">Category</th>
                      <th className="text-right text-xs font-medium text-slate-400 py-2">Hits</th>
                      <th className="text-right text-xs font-medium text-slate-400 py-2">Review</th>
                      <th className="text-right text-xs font-medium text-slate-400 py-2">Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {risk.breakdown.map((row, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="py-2 text-slate-300">{row.category}</td>
                        <td className="py-2 text-right text-red-400">{row.hits || "—"}</td>
                        <td className="py-2 text-right text-amber-400">{row.uncertains || "—"}</td>
                        <td className="py-2 text-right text-white font-medium">+{row.contribution}</td>
                      </tr>
                    ))}
                    <tr>
                      <td className="pt-3 text-slate-400 font-medium">Total</td>
                      <td className="pt-3"></td>
                      <td className="pt-3"></td>
                      <td className={`pt-3 text-right font-bold ${riskColor}`}>{risk.score}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {/* Risk Assessment — honest about what the engine actually observed */}
            <div className="bg-slate-900 rounded-xl border border-white/10 p-6">
              <h3 className="text-sm font-medium text-slate-300 mb-3">Risk Assessment</h3>
              <div className="text-sm text-slate-400 space-y-2">
                <p>
                  Automated screening of <strong className="text-white">{screening.entity_name}</strong> ran {checks.length} database check(s):
                  <span className="text-emerald-400"> {clearCount} confirmed no-match</span>,
                  <span className="text-red-400"> {hitCount} hit</span>,
                  <span className="text-amber-400"> {uncertainCount} to review</span>,
                  <span className="text-orange-400"> {errorCount} error</span>.
                </p>
                {risk.level === "REJECT" && (
                  <>
                    <p>
                      <strong className="text-red-500">A sanctions match was confirmed against {screening.entity_name}</strong> on one or more sources. Do not onboard or process this entity, and report to the compliance officer and/or the FID as required by law.
                    </p>
                    <p>Recommended: block the relationship and document the evidence (screenshots and source URLs) in the compliance file.</p>
                  </>
                )}
                {risk.level === "HIGH" && (
                  <>
                    <p>
                      <strong className="text-orange-400">A sanctions source returned a result that could not be confirmed as a no-match</strong> — the result page does not match the expected clean-result layout. Treat {screening.entity_name} as high risk until a human reviews the captured evidence.
                    </p>
                    <p>Recommended: inspect each sanctions check flagged for investigation. If all are confirmed clean on manual review, re-run the screening with a clarified alias; otherwise escalate to enhanced due diligence.</p>
                  </>
                )}
                {risk.level === "MEDIUM" && (
                  <>
                    <p>
                      <strong className="text-amber-400">{uncertainCount} check(s) need review</strong> — the result page was not recognisable as a confirmed no-match. This does not mean a match was found; it means a human must verify each flagged screenshot.
                    </p>
                    <p>Recommended: inspect each flagged result&apos;s screenshot. If all are confirmed clean, the risk drops to low. If any show a match, escalate to enhanced due diligence.</p>
                  </>
                )}
                {risk.level === "LOW-MEDIUM" && (
                  <>
                    <p>
                      Sanctions and PEP checks returned their confirmed no-match indicators, but <strong className="text-lime-400">the adverse-media search surfaced results that could not be confirmed as clean.</strong> Review the adverse-media screenshots for context before proceeding.
                    </p>
                    <p>Recommended: proceed with standard due diligence while documenting the adverse-media review in the compliance file.</p>
                  </>
                )}
                {risk.level === "LOW" && (
                  <>
                    <p>
                      Every sanctions and PEP database returned its confirmed no-match indicator for <strong className="text-white">{screening.entity_name}</strong>
                      {screening.persons?.length > 0 && ` and ${screening.persons.length} associated person(s)`}.
                    </p>
                    <p>Recommended: proceed with standard due diligence per your internal AML policy. Retain the evidence screenshots for audit.</p>
                  </>
                )}
                {risk.incomplete && (
                  <p className="pt-2 text-orange-400">
                    <strong>Note:</strong> {errorCount} database check(s) returned errors (typically bot-detection or network timeouts). Re-run the screening or verify the affected sources manually — the risk level above is based only on checks that completed.
                  </p>
                )}
              </div>
            </div>

            {/* Sources Attribution */}
            <div className="bg-slate-900 rounded-xl border border-white/10 p-6">
              <h3 className="text-sm font-medium text-slate-300 mb-3">Sources</h3>
              <div className="text-sm text-slate-400 space-y-2">
                <p>
                  Sanctions: <strong className="text-white">OFAC SDN</strong> (US Treasury),{" "}
                  <strong className="text-white">UK Sanctions List</strong> (GOV.UK / FCDO), and the Latvian{" "}
                  <strong className="text-white">FID consolidated sanctions list</strong> (Latvia, EU, UN, US, UK, AU — aggregated and served by{" "}
                  <a href="https://www.firmas.lv/lv/sankcijas" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">Firmas.lv</a>
                  {" "}with the source list published by the{" "}
                  <a href="https://fid.gov.lv/lv" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:text-emerald-300 underline underline-offset-2">Financial Intelligence Unit of Latvia</a>).
                </p>
                <p>
                  PEP: <strong className="text-white">VID PNP</strong> (tax debtors) and <strong className="text-white">VID VAD</strong> (officials&apos; declarations). Adverse media via DuckDuckGo across LV/EN/ET/RU. Company registry via Uzņēmumu reģistrs.
                </p>
                <p className="text-xs text-slate-500">
                  Every check in the Checks tab links to its live source URL — the screenshot is captured at that URL with a timestamped evidence header.
                </p>
              </div>
            </div>

            {/* Screening Summary */}
            <div className="bg-slate-900 rounded-xl border border-white/10 p-6">
              <h3 className="text-sm font-medium text-slate-300 mb-3">Screening Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="text-center">
                  <p className="text-2xl font-bold text-white">{checks.length}</p>
                  <p className="text-xs text-slate-500">Total Checks</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-emerald-400">{clearCount}</p>
                  <p className="text-xs text-slate-500">Clear</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-red-400">{hitCount}</p>
                  <p className="text-xs text-slate-500">Hits</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-amber-400">{uncertainCount}</p>
                  <p className="text-xs text-slate-500">Review</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-orange-400">{errorCount}</p>
                  <p className="text-xs text-slate-500">Errors</p>
                </div>
              </div>
            </div>

            {/* Compliance Annexes — Latvian Bar Association (Instrukcija NILLTPFN-SL) */}
            <div className="bg-slate-900 rounded-xl border border-white/10 p-6">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div>
                  <h3 className="text-sm font-medium text-slate-300">Latvijas Advokātu padomes pielikumi (SAGATAVE)</h3>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                    Automātiski priekšaizpildītas veidlapas pēc Instrukcijas NILLTPFN-SL. Advokāts tās pārskata un papildina; klients paraksta P3.x pēc pārskatīšanas.
                  </p>
                </div>
                <a
                  href="https://www.advokatura.lv/lv/nilltpfnl-sl-jautajumi/advokatu-instrukcija-nilltpfn-sl/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-1 shrink-0 mt-0.5"
                >
                  advokatura.lv <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              <div className="mb-4 flex items-center gap-2">
                <label className="text-xs text-slate-400 shrink-0">Atbildīgā persona:</label>
                <input
                  type="text"
                  value={annexReviewer}
                  onChange={(e) => setAnnexReviewer(e.target.value)}
                  placeholder="Vārds, uzvārds (advokāts)"
                  disabled={demoMode}
                  className="flex-1 h-8 px-2.5 text-xs bg-slate-800 border border-white/10 rounded-md text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50 disabled:opacity-60"
                />
              </div>

              <div className="space-y-2">
                {resolveVariants(screening).map(variant => {
                  const meta = ANNEX_META[variant];
                  const pdfUrl = `/api/screenings/${screening.id}/annex/${variant}/export.pdf?reviewer=${encodeURIComponent(annexReviewer)}`;
                  const docxUrl = `/api/screenings/${screening.id}/annex/${variant}/export.docx?reviewer=${encodeURIComponent(annexReviewer)}`;
                  const disabled = demoMode || screening.status !== "completed";
                  const disabledTitle = demoMode ? "Sign in to download" : "Screening not complete";
                  return (
                    <div key={variant} className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-lg border border-white/5">
                      <FileText className="w-5 h-5 text-emerald-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-200">
                          <span className="text-slate-400 font-mono text-xs mr-2">{meta.code}</span>
                          {meta.titleLv}
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">{meta.titleEn}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => setOpenAnnex(variant)}
                          disabled={disabled}
                          className="inline-flex items-center gap-1.5 px-3 h-8 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title={demoMode ? "Sign in to preview" : screening.status !== "completed" ? "Screening not complete" : undefined}
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Priekšskatījums
                        </button>
                        {disabled ? (
                          <>
                            <button
                              type="button"
                              disabled
                              className="inline-flex items-center gap-1.5 px-3 h-8 text-xs bg-emerald-600/50 text-white/70 rounded-md cursor-not-allowed"
                              title={disabledTitle}
                            >
                              <Download className="w-3.5 h-3.5" />
                              PDF
                            </button>
                            <button
                              type="button"
                              disabled
                              className="inline-flex items-center gap-1.5 px-3 h-8 text-xs bg-slate-700/50 text-slate-300/70 rounded-md cursor-not-allowed border border-white/10"
                              title={disabledTitle}
                            >
                              <Download className="w-3.5 h-3.5" />
                              DOCX
                            </button>
                          </>
                        ) : (
                          <>
                            <a
                              href={pdfUrl}
                              className="inline-flex items-center gap-1.5 px-3 h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-md transition-colors"
                            >
                              <Download className="w-3.5 h-3.5" />
                              PDF
                            </a>
                            <a
                              href={docxUrl}
                              className="inline-flex items-center gap-1.5 px-3 h-8 text-xs bg-slate-700 hover:bg-slate-600 text-slate-100 rounded-md transition-colors border border-white/10"
                            >
                              <Download className="w-3.5 h-3.5" />
                              DOCX
                            </a>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              <p className="text-xs text-slate-600 mt-4 leading-relaxed">
                Katra veidlapa ģenerējas ar SAGATAVE atzīmi — tā nav gala redakcija un nav iesniegšanai gatava. Advokāta uzdevums ir pārskatīt, papildināt nepieciešamos laukus un, klienta parakstītajām veidlapām (P3.x), saņemt klienta parakstu pirms iesniegšanas.
              </p>
            </div>

            {openAnnex && (
              <AnnexPreviewModal
                screeningId={screening.id}
                variant={openAnnex}
                open={!!openAnnex}
                defaultReviewer={annexReviewer}
                onOpenChange={(open) => { if (!open) setOpenAnnex(null); }}
              />
            )}

            {/* CTA */}
            <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-6 text-center">
              <Shield className="w-8 h-8 text-emerald-500 mx-auto mb-3" />
              <h3 className="text-white font-medium mb-2">
                {demoMode ? "Run Your Own AML Screening" : "Get Full Analysis & Compliance Documentation"}
              </h3>
              <p className="text-sm text-slate-400 mb-4 max-w-md mx-auto">
                {demoMode
                  ? "Sign in to screen any entity across 8+ databases with automated evidence collection. Your first screening is free."
                  : "Receive expert risk evaluation, pre-filled compliance forms, regulatory filing guidance, and ongoing monitoring setup."}
              </p>
              {demoMode ? (
                <a
                  href="/login"
                  className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-xl font-medium transition-colors"
                >
                  Start Your Free Screening
                  <ExternalLink className="w-4 h-4" />
                </a>
              ) : (
                <a
                  href="https://github.com/SigvardsK/eu-aml-screening/issues/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-3 rounded-xl font-medium transition-colors"
                >
                  Open an issue on GitHub
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
