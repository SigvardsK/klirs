/**
 * Local annex template render test — pulls a real screening from Supabase
 * and writes the three annex HTML files to /tmp/aml-annex-render/ so we
 * can open them in a browser and visually verify before deploying.
 *
 * Usage:
 *   npx tsx scripts/test-annex-render.ts <screening-id>
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { config } from "dotenv";
import { deriveRisk } from "../src/lib/risk-score";
import type { Screening, ScreeningCheck } from "../src/lib/types";
import {
  buildAnnexP2Html,
  buildAnnexP31Html,
  buildAnnexP32Html,
} from "../src/lib/annex/templates";

config({ path: ".env.local" });

const id = process.argv[2];
if (!id) {
  console.error("Usage: npx tsx scripts/test-annex-render.ts <screening-id>");
  process.exit(1);
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );

  const { data: screeningRow, error: e1 } = await supabase
    .from("screenings")
    .select("*")
    .eq("id", id)
    .single();
  if (e1 || !screeningRow) {
    console.error("Screening not found:", e1);
    process.exit(1);
  }
  const screening = screeningRow as Screening;

  const { data: checks, error: e2 } = await supabase
    .from("screening_checks")
    .select("*")
    .eq("screening_id", id)
    .order("checked_at", { ascending: true });
  if (e2) {
    console.error("Checks fetch failed:", e2);
    process.exit(1);
  }

  const risk = deriveRisk((checks || []) as ScreeningCheck[]);
  const ctx = {
    screening,
    checks: (checks || []) as ScreeningCheck[],
    risk,
    reviewer: "Test Reviewer",
  };

  mkdirSync("/tmp/aml-annex-render", { recursive: true });

  const p2 = buildAnnexP2Html(ctx);
  writeFileSync("/tmp/aml-annex-render/p2.html", p2);
  console.log(`p2.html: ${p2.length} bytes`);

  if (screening.entity_type === "individual") {
    const p31 = buildAnnexP31Html(ctx);
    writeFileSync("/tmp/aml-annex-render/p3_1.html", p31);
    console.log(`p3_1.html: ${p31.length} bytes`);
  } else {
    const p32 = buildAnnexP32Html(ctx);
    writeFileSync("/tmp/aml-annex-render/p3_2.html", p32);
    console.log(`p3_2.html: ${p32.length} bytes`);
  }

  console.log("---");
  console.log("Entity:", screening.entity_name, `(${screening.entity_type})`);
  console.log("Jurisdiction:", screening.jurisdiction);
  console.log("Reg No:", screening.registration_number || "—");
  console.log("Persons:", (screening.persons || []).map(p => p.name).join(", ") || "—");
  console.log("Risk:", risk.level, `(score ${risk.score})`);
  console.log("Hits:", (checks || []).filter(c => c.status === "hit").length);
  console.log("Uncertain:", (checks || []).filter(c => c.status === "uncertain").length);
  console.log("Clear:", (checks || []).filter(c => c.status === "clear").length);
}

main().catch(err => { console.error(err); process.exit(1); });
