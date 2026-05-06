/**
 * Magic-link confirmation — token-hash flow (Brave-compatible).
 *
 * Why this exists: the default magic-link flow uses PKCE — Supabase emails a
 * `?code=…` link, the callback exchanges code+verifier (cookie) for a session.
 * Brave Shields drop the verifier cookie in privacy-aggressive contexts (same
 * root cause as the OAuth fix), so magic-link breaks for Brave users.
 *
 * Token-hash flow doesn't use PKCE: Supabase emails a `?token_hash=…&type=…`
 * link, this route calls `supabase.auth.verifyOtp({ token_hash, type })` which
 * verifies the token directly and writes session cookies on the response.
 * No verifier cookie required, so Brave Shields has nothing to break.
 *
 * Activated by changing the Supabase email template (Authentication → Email
 * Templates → Magic Link) to render the link as:
 *   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=magiclink
 *
 * Reference: https://supabase.com/docs/guides/auth/server-side/email-based-auth
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { EmailOtpType } from "@supabase/supabase-js";

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

/**
 * 200 HTML interstitial instead of 307 redirect on success — Brave Shields
 * drops Set-Cookie on cross-origin → redirect chains in incognito (magic
 * link is clicked from an email client, often a different origin). Cookies
 * set via the @supabase/ssr `setAll` callback ride on whatever Response we
 * return. Mirrors /auth/callback. See LR-2026-001 for class context.
 */
function htmlRedirect(targetPath: string): NextResponse {
  const html = `<!doctype html><html><head>
<meta http-equiv="refresh" content="0;url=${targetPath}">
<title>Signing in…</title>
<script>window.location.replace(${JSON.stringify(targetPath)});</script>
</head><body><p>Signing in…</p></body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

const VALID_OTP_TYPES: ReadonlySet<EmailOtpType> = new Set([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

export async function GET(request: Request) {
  const origin = getOrigin(request);
  try {
    const { searchParams } = new URL(request.url);
    const tokenHash = searchParams.get("token_hash");
    const rawType = searchParams.get("type");
    const type =
      rawType && VALID_OTP_TYPES.has(rawType as EmailOtpType)
        ? (rawType as EmailOtpType)
        : null;

    if (!tokenHash || !type) {
      console.error("[auth/confirm] missing_params", {
        hasTokenHash: !!tokenHash,
        rawType,
      });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent(
          `confirm_missing_params: hasTokenHash=${!!tokenHash} type=${rawType ?? "null"}`
        )}`
      );
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });

    if (error) {
      console.error("[auth/confirm] verify_failed", {
        message: error.message,
        status: error.status,
      });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent(`verify_otp: ${error.message}`)}`
      );
    }

    // Sync profile name from auth metadata (mirrors /auth/callback path).
    const {
      data: { user },
      error: getUserError,
    } = await supabase.auth.getUser();
    if (getUserError || !user) {
      console.error("[auth/confirm] getUser_failed_after_verify", {
        message: getUserError?.message,
        hasUser: !!user,
      });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent(getUserError?.message ?? "no_user_after_verify")}`
      );
    }

    const name = user.user_metadata?.full_name || user.user_metadata?.name;
    const email = user.email;
    // Admin client bypasses RLS. Payload is constrained to fields derived from
    // the verified getUser() result, so this is safe — and decouples the
    // post-auth metadata sync from RLS policy drift.
    const adminForUpsert = createAdminClient();
    const { error: upsertError } = await adminForUpsert.from("profiles").upsert(
      {
        id: user.id,
        full_name: name || email?.split("@")[0] || "User",
        email,
      },
      { onConflict: "id" }
    );
    if (upsertError) {
      console.error("[auth/confirm] profile_upsert_failed", {
        message: upsertError.message,
        code: upsertError.code,
      });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent(`profile_upsert: ${upsertError.message}`)}`
      );
    }

    return htmlRedirect("/dashboard");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error("[auth/confirm] unhandled_throw", { name, message });
    return NextResponse.redirect(
      `${origin}/login?error=auth_failed&detail=${encodeURIComponent(`confirm_unhandled: ${name}: ${message}`)}`
    );
  }
}
