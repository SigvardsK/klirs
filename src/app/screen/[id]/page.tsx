import { createClient } from "@supabase/supabase-js";
import { LiveProgress } from "@/components/live-progress";
import { ScreenExpired } from "@/components/screen-expired";
import type { Screening, ScreeningCheck } from "@/lib/types";
import type { Metadata } from "next";

/**
 * /screen/[id] — public result page for a demo screening.
 *
 * Server component. Single source-key fetch with the same 24h retention gate
 * as /api/demo/[id]/*. Hands off to <LiveProgress /> for the client-side poll
 * + render. If the screening is missing or past the 24h window, the
 * service-key admin client returns nothing and we render <ScreenExpired />
 * (NOT a redirect — buyers need to see "this trial result expired" to
 * understand the 24h public-window contract).
 *
 * Locale-agnostic: the result page is read by both EN + LV visitors. Strings
 * for now are EN-only; LV i18n folds in once Phase 4 lands.
 */

const RETENTION_HOURS = 24;

function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
}

interface InitialFetch {
  screening: Screening;
  initialCompletedChecks: ScreeningCheck[];
}

async function fetchInitial(id: string): Promise<InitialFetch | null> {
  const supabase = getAdminClient();
  const since = new Date(
    Date.now() - RETENTION_HOURS * 60 * 60 * 1000
  ).toISOString();

  const { data: screening, error } = await supabase
    .from("screenings")
    .select("*")
    .eq("id", id)
    .eq("is_demo", true)
    .gte("created_at", since)
    .single();

  if (error || !screening) return null;

  const { data: checks } = await supabase
    .from("screening_checks")
    .select("*")
    .eq("screening_id", id)
    .order("checked_at", { ascending: true });

  return {
    screening: screening as Screening,
    initialCompletedChecks: (checks ?? []) as ScreeningCheck[],
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const fetched = await fetchInitial(id);
  if (!fetched) {
    return {
      title: "Trial expired — Klirs",
      robots: { index: false, follow: false },
    };
  }
  return {
    title: `${fetched.screening.entity_name} — Klirs screening`,
    description: "AML/KYC screening result powered by Klirs.",
    robots: { index: false, follow: false }, // demo result URLs are 24h public; not for indexing
  };
}

export default async function ScreenPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const fetched = await fetchInitial(id);

  if (!fetched) {
    return <ScreenExpired />;
  }

  return (
    <LiveProgress
      screeningId={id}
      initialScreening={fetched.screening}
      initialCompletedChecks={fetched.initialCompletedChecks}
    />
  );
}
