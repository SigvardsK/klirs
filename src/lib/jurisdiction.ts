/**
 * Jurisdiction scoping for source selection.
 *
 * The engine runs two classes of source:
 *  - Cross-border: global sanctions (OFAC / UK / the FID-aggregated EU·UN·US·UK·AU
 *    consolidated list) and adverse media — these apply to EVERY screening
 *    regardless of the entity's jurisdiction.
 *  - Latvia-national: VID PEP (PNP / VAD) and the Latvian company registry (UR) —
 *    these only make sense for a Latvian entity. They are flagged `latviaOnly`
 *    in db-configs.
 *
 * A non-LV jurisdiction (currently "EU") therefore runs sanctions + adverse media
 * only, and DOES NOT run the Latvian PEP / registry sources.
 *
 * Correctness note (LR-WS-2026-029): skipping the Latvian sources for an EU entity
 * does NOT default them to `clear`. They are simply not part of the screen — no
 * `screening_checks` row is written for them, and `deriveRisk` scores only over
 * the checks that actually ran. Absence of a Latvian PEP source for a non-LV
 * entity is correct scoping, not a silent false-clear.
 */
export function isLatviaJurisdiction(
  jurisdiction: string | null | undefined
): boolean {
  return (jurisdiction ?? "").trim().toUpperCase() === "LV";
}
