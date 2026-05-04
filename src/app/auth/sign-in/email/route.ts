/**
 * Server-side email magic-link initiation — token-hash flow.
 *
 * Why token-hash instead of PKCE: Brave Shields (and similar privacy
 * features in Firefox-strict / Safari-ITP) drop the verifier cookie that
 * the PKCE-code flow depends on. Token-hash flow doesn't use PKCE at all —
 * Supabase emails a one-time token, /auth/confirm verifies it directly via
 * verifyOtp({ token_hash, type }). No verifier cookie needed.
 *
 * Activation requires a Supabase email template change (Authentication →
 * Email Templates → Magic Link) so the email link points at our /auth/
 * confirm route with `?token_hash={{ .TokenHash }}&type=magiclink` — see
 * the comment in /auth/confirm/route.ts for the exact template body.
 *
 * `emailRedirectTo` here is the fallback the email template references via
 * {{ .SiteURL }}; the explicit `?token_hash=…` URL takes precedence.
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
        emailRedirectTo: `${origin}/auth/confirm`,
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
