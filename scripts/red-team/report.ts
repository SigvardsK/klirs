/**
 * Red-team report writer — assembles findings into a markdown artefact
 * the lawyer (and the maintainer) can scan for BLOCKER / IMPORTANT items.
 */

import { writeFileSync } from "node:fs";
import type { CheckSummary, Timings } from "./capture";
import type { RedTeamCase } from "./cases";

export type Priority = "BLOCKER" | "IMPORTANT" | "NICE-TO-HAVE";

export interface Finding {
  id: string;            // short stable id, e.g. "F1"
  priority: Priority;
  area: string;          // "Form", "Results", "Annex P2", "PDF", "Copy"
  title: string;
  detail: string;
  caseId: string;        // which case surfaced it
  recommendation?: string;
}

export interface CaseRun {
  caseId: string;
  title: string;
  screeningId: string | null;
  submitUrl: string | null;
  resultUrl: string | null;
  pass: boolean;
  verdictReasons: string[];
  timings: Timings;
  checks: CheckSummary[];
  annexHttp: { variant: string; previewStatus: number; pdfStatus: number; pdfBytes: number }[];
  screenshots: string[];
}

export interface ReportInput {
  generatedAt: string;
  baseUrl: string;
  authUser: string;
  commit: string;
  runs: CaseRun[];
  findings: Finding[];
}

function fmtMs(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusCounts(checks: CheckSummary[]): string {
  const c = { clear: 0, hit: 0, uncertain: 0, error: 0, pending: 0 } as Record<string, number>;
  for (const ch of checks) c[ch.status] = (c[ch.status] || 0) + 1;
  return `${c.clear} clear · ${c.hit} hit · ${c.uncertain} review · ${c.error} error`;
}

export function writeReport(out: string, input: ReportInput): void {
  const blockers = input.findings.filter(f => f.priority === "BLOCKER");
  const importants = input.findings.filter(f => f.priority === "IMPORTANT");
  const nice = input.findings.filter(f => f.priority === "NICE-TO-HAVE");

  const lines: string[] = [];
  lines.push(`# Lawyer Red-Team Report — ${input.generatedAt}`);
  lines.push("");
  lines.push("## Executive summary");
  lines.push("");
  lines.push(`- **${blockers.length} BLOCKER(s)** — MUST fix before sending the demo link externally.`);
  lines.push(`- **${importants.length} IMPORTANT** — queue for next round.`);
  lines.push(`- **${nice.length} NICE-TO-HAVE** — backlog.`);
  const passCount = input.runs.filter(r => r.pass).length;
  lines.push(`- **${passCount}/${input.runs.length} cases passed.**`);
  if (blockers.length === 0 && passCount === input.runs.length) {
    lines.push(`- **✓ SAFE to send.**`);
  } else {
    lines.push(`- **✗ NOT safe to send** until BLOCKERs are fixed and all cases pass.`);
  }
  lines.push("");
  lines.push(`> Run metadata — Base URL: \`${input.baseUrl}\` · Auth user: \`${input.authUser}\` · Commit: \`${input.commit}\``);
  lines.push("");

  lines.push("## Findings");
  lines.push("");
  lines.push("| # | Priority | Area | Finding | Case | Recommendation |");
  lines.push("|---|----------|------|---------|------|----------------|");
  const sortOrder: Record<Priority, number> = { BLOCKER: 0, IMPORTANT: 1, "NICE-TO-HAVE": 2 };
  const sortedFindings = [...input.findings].sort((a, b) => sortOrder[a.priority] - sortOrder[b.priority]);
  for (const f of sortedFindings) {
    lines.push(`| ${f.id} | **${f.priority}** | ${f.area} | **${f.title}** — ${f.detail.replace(/\|/g, "\\|")} | ${f.caseId} | ${(f.recommendation || "—").replace(/\|/g, "\\|")} |`);
  }
  if (input.findings.length === 0) {
    lines.push(`| — | — | — | (no findings recorded) | — | — |`);
  }
  lines.push("");

  lines.push("## Cases");
  lines.push("");
  for (const r of input.runs) {
    lines.push(`### ${r.title} — ${r.pass ? "✓ PASS" : "✗ FAIL"}`);
    lines.push("");
    lines.push(`- Screening ID: \`${r.screeningId || "—"}\``);
    if (r.resultUrl) lines.push(`- Result URL: [${r.resultUrl}](${r.resultUrl})`);
    lines.push(`- Timings: submit → first check ${fmtMs(r.timings.submit_to_first_check_ms)} · submit → completed ${fmtMs(r.timings.submit_to_completed_ms)}`);
    lines.push(`- Checks: ${statusCounts(r.checks)} (${r.checks.length} total)`);
    if (r.annexHttp.length) {
      lines.push("- Annexes:");
      for (const a of r.annexHttp) {
        lines.push(`  - \`${a.variant}\`: preview HTTP ${a.previewStatus} · PDF HTTP ${a.pdfStatus} (${(a.pdfBytes / 1024).toFixed(1)} kB)`);
      }
    }
    if (r.verdictReasons.length) {
      lines.push("- Verdict notes:");
      for (const reason of r.verdictReasons) {
        lines.push(`  - ${reason}`);
      }
    }
    if (r.screenshots.length) {
      lines.push("- Screenshots:");
      for (const s of r.screenshots) {
        lines.push(`  - \`${s.split("/").slice(-2).join("/")}\``);
      }
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`Generated ${input.generatedAt} by scripts/red-team/run-cases.ts.`);

  writeFileSync(out, lines.join("\n"), "utf-8");
}
