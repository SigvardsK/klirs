import { createClient } from "@supabase/supabase-js";
import { getTranslations } from "next-intl/server";
import { LiveProgress, type ResultCopy } from "@/components/live-progress";
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
 * Locale-agnostic route (lives outside the [locale] segment) but locale-aware
 * copy: next-intl resolves the active locale from the request (cookie/header)
 * via getTranslations, and the resolved strings are passed into <LiveProgress />
 * as a `copy` bag (the client component cannot read next-intl server messages).
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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ left?: string }>;
}) {
  const { id } = await params;
  const { left: leftParam } = await searchParams;
  const fetched = await fetchInitial(id);

  if (!fetched) {
    return <ScreenExpired />;
  }

  // Resolve the ICU-pluralized free-search line here, where next-intl can
  // select the right plural form against the actual ?left= count. Client only
  // decides freeLeft-vs-lastFree (it reads the same ?left= param).
  const leftNum = Number.parseInt(leftParam ?? "", 10);
  const t = await getTranslations();
  const copy: ResultCopy = {
    runAnother: t("result.runAnother"),
    signIn: t("result.signIn"),
    themeToLight: t("common.themeToggleToLight"),
    themeToDark: t("common.themeToggleToDark"),
    freeLeftTemplate: t("result.freeLeft", {
      n: Number.isFinite(leftNum) ? leftNum : 0,
    }),
    lastFree: t("result.lastFree"),
    saveResultTitle: t("result.saveResultTitle"),
    saveResultBody: t("result.saveResultBody"),
    bookDemoTitle: t("result.bookDemoTitle"),
    bookDemoBody: t("result.bookDemoBody"),
  };

  return (
    <LiveProgress
      screeningId={id}
      initialScreening={fetched.screening}
      initialCompletedChecks={fetched.initialCompletedChecks}
      copy={copy}
    />
  );
}
