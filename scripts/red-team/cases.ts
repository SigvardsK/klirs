/**
 * Red-team test case definitions — three lawyer-persona workflows.
 *
 * Cases lock the contract that matters for compliance review: trustable
 * verdicts (no false-negatives on known-sanctioned individuals), full
 * source-URL audit trail, defensible category-weighted risk score, and
 * filable annex artefacts.
 *
 * Each case submits a full screening from /screenings/new, waits for
 * completion, verifies expectations against the result, and generates
 * all applicable annex PDFs.
 */

export type ExpectedRiskLevel = "LOW" | "LOW-MEDIUM" | "MEDIUM" | "HIGH" | "REJECT";

export interface RedTeamCase {
  id: string;                  // slug for artefact folder
  title: string;               // human title
  entityType: "individual" | "company";
  entityName: string;
  jurisdiction: string;        // 2-letter ISO
  registrationNumber?: string;
  persons?: { name: string; role: string; aliases?: string[] }[];
  // Single-person individual: top-level aliases (matches the UI's Round-3 form shape).
  individualAliases?: string[];
  expectedRisk: ExpectedRiskLevel[];           // pass if actual ∈ this set
  expectedSanctionsHit?: string[];             // database names that MUST return hit
  expectedNoSanctionsHit?: boolean;            // pass if zero sanctions hits across all sources
  expectedAnnexes: ("p2" | "p3_1" | "p3_2")[];
}

export const CASES: RedTeamCase[] = [
  {
    id: "kadyrov",
    title: "Ramzan Kadyrov — sanctioned individual",
    entityType: "individual",
    entityName: "Ramzan Kadyrov",
    // Form dropdown has LV/EE/LT/EU only — use "EU" for non-EU nationals
    // until the product widens jurisdiction coverage. Not ideal UX but
    // matches what a LV lawyer would click today.
    jurisdiction: "EU",
    individualAliases: ["Рамзан Кадыров"],
    // With UK Sanctions sometimes rate-limited on Railway datacenter IPs,
    // accept a verdict driven by Firmas + OFAC too — still REJECT/HIGH.
    expectedRisk: ["REJECT", "HIGH"],
    // Firmas is the reliable hit source; UK is aspirational this round.
    expectedSanctionsHit: ["FID consolidated sanctions (via Firmas.lv)"],
    expectedAnnexes: ["p2", "p3_1"],
  },
  {
    id: "berzins",
    title: "Jānis Bērziņš — clean common Latvian name",
    entityType: "individual",
    entityName: "Jānis Bērziņš",
    jurisdiction: "LV",
    expectedRisk: ["LOW", "LOW-MEDIUM"],
    expectedNoSanctionsHit: true,
    expectedAnnexes: ["p2", "p3_1"],
  },
  {
    id: "mikrotikls",
    title: "SIA Mikrotīkls — clean LV company with UBOs",
    entityType: "company",
    entityName: "SIA Mikrotīkls",
    jurisdiction: "LV",
    registrationNumber: "40003286799",
    persons: [
      { name: "Arnis Riekstiņš", role: "Valdes loceklis" },
      { name: "Juris Ulmanis", role: "Valdes loceklis" },
    ],
    expectedRisk: ["LOW", "LOW-MEDIUM"],
    expectedNoSanctionsHit: true,
    expectedAnnexes: ["p2", "p3_2"],
  },
];
