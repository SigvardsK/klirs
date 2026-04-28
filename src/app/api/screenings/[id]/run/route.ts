import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { runScreening, calculateTotalChecks } from "@/lib/screening-engine";
import type { Person } from "@/lib/types";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  // Verify user owns this screening
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: screening, error } = await supabase
    .from("screenings")
    .select("*")
    .eq("id", id)
    .eq("created_by", user.id)
    .single();

  if (error || !screening) {
    return NextResponse.json({ error: "Screening not found" }, { status: 404 });
  }

  if (screening.status !== "pending") {
    return NextResponse.json({ error: "Screening already started" }, { status: 400 });
  }

  // Defense-in-depth individual guard: a screening with entity_type='individual'
  // and no associated persons would skip every persons-only check (VID PNP/VAD,
  // adverse media) — the exact shape that produced silent false-negatives in an
  // earlier prototype. Synthesize a person from the entity name so those checks
  // always run for individuals.
  let persons = (screening.persons || []) as Person[];
  if (screening.entity_type === "individual" && persons.every(p => !p.name?.trim())) {
    persons = [{ name: screening.entity_name, role: "", aliases: [] }];
  }

  const job = {
    screeningId: id,
    entityName: screening.entity_name,
    entityType: screening.entity_type as "company" | "individual",
    jurisdiction: screening.jurisdiction,
    registrationNumber: screening.registration_number,
    persons,
  };

  // Fire and forget — don't await the screening
  runScreening(job).catch(err => {
    console.error("Background screening failed:", err);
  });

  return NextResponse.json(
    { message: "Screening started", totalChecks: calculateTotalChecks(job) },
    { status: 202 }
  );
}
