import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSuperuserEmail } from "@/lib/constants";
import { ScreeningForm } from "./screening-form";

/**
 * Server-component shell for /screenings/new.
 *
 * Reads the superuser status server-side (where `process.env.SUPERUSER_EMAILS`
 * is actually defined) and passes it as a prop to the client form. The form
 * itself stays client-rendered because of its interactive state. This is the
 * fix for the freemium-gate bug where the client component read
 * `process.env.SUPERUSER_EMAILS` directly — Next.js only exposes env vars to
 * the client when prefixed with `NEXT_PUBLIC_`, so the constant resolved to
 * `[]` for everyone and the bypass never fired.
 */
export default async function NewScreeningPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const isSuperuser = isSuperuserEmail(user.email);
  return <ScreeningForm isSuperuser={isSuperuser} />;
}
