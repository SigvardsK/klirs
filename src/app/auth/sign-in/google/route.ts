/**
 * Server-side Google OAuth initiation — Brave-compatible.
 *
 * Why we don't call supabase.auth.signInWithOAuth: that path stores the PKCE
 * verifier in a cookie set on the 303 response that immediately redirects to
 * supabase.co. Brave Shields (and similar privacy features in Firefox-strict /
 * Safari-ITP) classify "Set-Cookie + Location to different origin" as bounce-
 * tracking and silently drop the cookie. The callback then can't find the
 * verifier, surfacing "PKCE code verifier not found in storage."
 *
 * Instead: generate the verifier + challenge ourselves, store the verifier in
 * `auth_pkce_state` keyed by an opaque state token, construct the Supabase
 * OAuth URL ourselves, and 303-redirect. NO cookie is set on this response,
 * so Brave Shields has nothing to flag. The state token passes through the
 * OAuth chain (Supabase forwards it on the callback URL) and the callback
 * looks the verifier up by state.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generatePkcePair, generateState } from "@/lib/auth/pkce";

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
    const { verifier, challenge } = generatePkcePair();
    const state = generateState();

    const admin = createAdminClient();
    const { error: insertError } = await admin
      .from("auth_pkce_state")
      .insert({ state, code_verifier: verifier });
    if (insertError) {
      console.error("[auth/sign-in/google] state_insert_failed", {
        message: insertError.message,
        code: insertError.code,
      });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent(`state_insert: ${insertError.message}`)}`,
        303
      );
    }

    // Embed our state token in `redirect_to` rather than the OAuth `state`
    // param. Supabase manages its own CSRF state internally on
    // /auth/v1/authorize and rejects any caller-supplied `state` with
    // `bad_oauth_state`. The redirect_to URL is preserved verbatim across
    // the OAuth round-trip (Supabase appends `&code=…` on success), so
    // query-string-embedding our state is the canonical way to thread
    // app-specific context through. We use the param name `ks` (klirs
    // state) to avoid any chance of collision with Supabase's reserved names.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const callbackUrl = new URL("/auth/callback", origin);
    callbackUrl.searchParams.set("ks", state);
    const params = new URLSearchParams({
      provider: "google",
      redirect_to: callbackUrl.toString(),
      code_challenge: challenge,
      code_challenge_method: "s256",
    });
    return NextResponse.redirect(
      `${supabaseUrl}/auth/v1/authorize?${params.toString()}`,
      303
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error("[auth/sign-in/google] unhandled_throw", { name, message });
    return NextResponse.redirect(
      `${origin}/login?error=auth_failed&detail=${encodeURIComponent(`oauth_init_unhandled: ${name}: ${message}`)}`,
      303
    );
  }
}
