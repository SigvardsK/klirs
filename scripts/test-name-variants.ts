/**
 * Inline assertions for src/lib/name-variants.ts.
 *
 * Usage: npx tsx scripts/test-name-variants.ts
 * Exit 0 = all asserts pass; exit 1 = at least one failure.
 *
 * These cases lock the LV-transliteration contract:
 * "Pjotrs Avens" → drop-s on both tokens; "Pjotr Avens" → 4 variants;
 * "Microsoft Corporation" → 2 variants; "John Smith" → up to 4 variants;
 * empty → empty; preserves casing + arbitrary whitespace.
 */

import { expandLvVariants, isAutoVariant } from "../src/lib/name-variants";

interface Case {
  label: string;
  input: string;
  expectIncludes: string[];
  expectExcludes?: string[];
  expectFirst?: string;
  expectMaxLen?: number;
}

const cases: Case[] = [
  {
    label: "Pjotrs Avens — drop-s on both tokens collapses add-s back to original",
    input: "Pjotrs Avens",
    expectIncludes: ["Pjotrs Avens", "Pjotr Aven"],
    expectFirst: "Pjotrs Avens",
    expectMaxLen: 4,
  },
  {
    label: "Pjotr Avens — full 4-way expansion (LV-transliteration regression case)",
    input: "Pjotr Avens",
    expectIncludes: [
      "Pjotr Avens",   // original
      "Pjotrs Avens",  // add-s on first → matches Firmas
      "Pjotr Aven",    // drop-s on second → matches OFAC PETR AVEN
      "Pjotrs Aven",   // both transforms
    ],
    expectFirst: "Pjotr Avens",
    expectMaxLen: 4,
  },
  {
    label: "Microsoft Corporation — Corporation has no LV-add path; Microsoft → Microsofts",
    input: "Microsoft Corporation",
    expectIncludes: ["Microsoft Corporation", "Microsofts Corporation"],
    expectFirst: "Microsoft Corporation",
    expectMaxLen: 4,
  },
  {
    label: "John Smith — generic English; up to 4 variants",
    input: "John Smith",
    expectIncludes: [
      "John Smith",
      "Johns Smith",
      "John Smiths",
      "Johns Smiths",
    ],
    expectFirst: "John Smith",
    expectMaxLen: 4,
  },
  {
    label: "Empty string returns empty array",
    input: "",
    expectIncludes: [],
    expectMaxLen: 0,
  },
  {
    label: "Single short token (< MIN_TOKEN_LEN=4) is not transformed",
    input: "Lee",
    expectIncludes: ["Lee"],
    expectExcludes: ["Lees", "Le"],
    expectMaxLen: 1,
  },
  {
    label: "Whitespace and casing preserved per token",
    input: "  Vladimirs   Putins  ",
    expectIncludes: ["Vladimirs Putins", "Vladimir Putin"],
    expectExcludes: ["vladimirs putins"],
    expectFirst: "Vladimirs Putins",
  },
];

let failed = 0;
let passed = 0;

for (const c of cases) {
  const out = expandLvVariants(c.input);
  const issues: string[] = [];

  if (c.expectFirst !== undefined && out[0] !== c.expectFirst) {
    issues.push(`expected first = "${c.expectFirst}", got "${out[0]}"`);
  }
  if (c.expectMaxLen !== undefined && out.length > c.expectMaxLen) {
    issues.push(`expected length ≤ ${c.expectMaxLen}, got ${out.length}`);
  }
  for (const want of c.expectIncludes) {
    if (!out.includes(want)) {
      issues.push(`missing variant "${want}"`);
    }
  }
  for (const bad of c.expectExcludes || []) {
    if (out.includes(bad)) {
      issues.push(`unexpected variant "${bad}" present`);
    }
  }

  if (issues.length === 0) {
    console.log(`  ✓ ${c.label}`);
    console.log(`      → [${out.map(v => `"${v}"`).join(", ")}]`);
    passed++;
  } else {
    console.log(`  ✗ ${c.label}`);
    console.log(`      → [${out.map(v => `"${v}"`).join(", ")}]`);
    for (const issue of issues) console.log(`      ! ${issue}`);
    failed++;
  }
}

// isAutoVariant
const originals = ["Pjotr Avens"];
const autoCases: Array<[string, boolean]> = [
  ["Pjotr Avens", false],
  ["Pjotrs Avens", true],
  ["  Pjotr Avens  ", false], // trim parity
];
console.log("\nisAutoVariant:");
for (const [term, expected] of autoCases) {
  const got = isAutoVariant(term, originals);
  if (got === expected) {
    console.log(`  ✓ "${term}" → ${got}`);
    passed++;
  } else {
    console.log(`  ✗ "${term}" → ${got} (expected ${expected})`);
    failed++;
  }
}

console.log(`\n${passed} passed · ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
