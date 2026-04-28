import type { Screening } from "@/lib/types";

/**
 * The three annex variants aml-demo can produce.
 *
 * Numbering maps to the Latvian Bar Association's Instrukcija NILLTPFN-SL
 * (published on advokatura.lv). P3.1/P3.2 are client-signed sanctions
 * declarations; P2 is the lawyer-authored client risk assessment.
 * aml-demo produces them as SAGATAVE — pre-filled drafts the advocate
 * reviews, completes, and (for P3.x) has the client sign.
 */
export type AnnexVariant = "p2" | "p3_1" | "p3_2";

export interface AnnexMeta {
  variant: AnnexVariant;
  code: string;         // "Pielikums Nr. 3.1"
  titleLv: string;
  titleEn: string;
  shortLv: string;      // short label for UI rows
  shortEn: string;
}

export const ANNEX_META: Record<AnnexVariant, AnnexMeta> = {
  p2: {
    variant: "p2",
    code: "Pielikums Nr. 2",
    titleLv: "Klienta risku novērtējuma veidlapa",
    titleEn: "Client risk assessment form",
    shortLv: "Risku novērtējums",
    shortEn: "Client risk assessment",
  },
  p3_1: {
    variant: "p3_1",
    code: "Pielikums Nr. 3.1",
    titleLv: "Sankciju izpētes veidlapa (fiziska persona)",
    titleEn: "Sanctions research form — natural person",
    shortLv: "Sankciju izpēte — fiziska persona",
    shortEn: "Sanctions research (natural person)",
  },
  p3_2: {
    variant: "p3_2",
    code: "Pielikums Nr. 3.2",
    titleLv: "Sankciju izpētes veidlapa (juridiska persona)",
    titleEn: "Sanctions research form — legal entity",
    shortLv: "Sankciju izpēte — juridiska persona",
    shortEn: "Sanctions research (legal entity)",
  },
};

export function resolveVariants(screening: Screening): AnnexVariant[] {
  if (screening.entity_type === "company") {
    return ["p2", "p3_2"];
  }
  return ["p2", "p3_1"];
}

export function isAnnexVariant(x: string): x is AnnexVariant {
  return x === "p2" || x === "p3_1" || x === "p3_2";
}
