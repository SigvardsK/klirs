/**
 * Server-side email magic-link initiation.
 *
 * Why server-side: same reason as /auth/sign-in/google — the PKCE verifier
 * must survive between "user clicks Send sign-in link" and "user clicks the
 * link in their email." Writing it through the server-side @supabase/ssr
 * response-cookie path is the canonical path that doesn't race with browser
 * navigation. The previous client-side `signInWithOtp` produced
 * `PKCE code verifier not found in storage` on the callback even within the
 * same browser session.
 *
 * Note on cross-browser email clicks: if the user submits the form in one
 * browser (e.g. incognito) and clicks the email link in their default
 * browser, the verifier cookie won't be present. That requires switching to
 * the token-hash flow (Supabase email-template change + a /auth/confirm
 * route that calls verifyOtp). Deferred — same-browser flow is the dominant
 * case and the one that needed unblocking before Tuesday outreach.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function getOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
  if (forwardedHost) return `${forwardedProto}://${forwardedHost}`;
  const host = request.headers.get("host");
  if (host && !host.startsWith("0.0.0.0") && !host.startsWith("127.0.0.1")) {
    return `${forwardedProto}://${host}`;
  }
  return new URL(request.url).origin;
}

export async function POST(request: Request) {
  const origin = getOrigin(request);
  try {
    const formData = await request.formData();
    const rawEmail = formData.get("email");
    const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
    if (!email) {
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent("email_missing")}`,
        303
      );
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${origin}/auth/callback`,
        shouldCreateUser: true,
      },
    });
    if (error) {
      console.error("[auth/sign-in/email] otp_failed", { message: error.message, status: error.status });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent(`otp_init: ${error.message}`)}`,
        303
      );
    }
    return NextResponse.redirect(
      `${origin}/login?sent=${encodeURIComponent(email)}`,
      303
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error("[auth/sign-in/email] unhandled_throw", { name, message });
    return NextResponse.redirect(
      `${origin}/login?error=auth_failed&detail=${encodeURIComponent(`otp_init_unhandled: ${name}: ${message}`)}`,
      303
    );
  }
}
