import { createClient } from "@/lib/supabase/server";
import { getCurrentUserProfile } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { Screening, ScreeningCheck } from "@/lib/types";
import { ScreeningViewer } from "@/components/screening-viewer";

export default async function ScreeningDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUserProfile();
  if (!user) redirect("/login");

  const supabase = await createClient();

  const { data: screening } = await supabase
    .from("screenings")
    .select("*")
    .eq("id", id)
    .eq("created_by", user.id)
    .single();

  if (!screening) notFound();

  const { data: checks } = await supabase
    .from("screening_checks")
    .select("*")
    .eq("screening_id", id)
    .order("checked_at", { ascending: true });

  // Default annex reviewer name — the runner's profile full_name. The client
  // component lets the lawyer override it before generating (partners often
  // sign instead of the associate who submitted).
  const { data: profile } = await supabase
    .from("profiles")
    .select("full_name")
    .eq("id", user.id)
    .single();
  const reviewerName = (profile?.full_name as string | null) || "";

  return (
    <div>
      <Link href="/dashboard" className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white mb-6">
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>

      <ScreeningViewer
        screening={screening as Screening}
        checks={(checks || []) as ScreeningCheck[]}
        supabaseUrl={process.env.NEXT_PUBLIC_SUPABASE_URL!}
        reviewerName={reviewerName}
      />
    </div>
  );
}
