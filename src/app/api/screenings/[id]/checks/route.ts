import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify user owns the screening
  const { data: screening } = await supabase
    .from("screenings")
    .select("id")
    .eq("id", id)
    .eq("created_by", user.id)
    .single();

  if (!screening) {
    return NextResponse.json({ error: "Screening not found" }, { status: 404 });
  }

  const { data: checks } = await supabase
    .from("screening_checks")
    .select("*")
    .eq("screening_id", id)
    .order("checked_at", { ascending: true });

  return NextResponse.json(checks || []);
}
