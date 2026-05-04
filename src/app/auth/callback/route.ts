import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * OAuth + magic-link callback — Brave-compatible PKCE exchange.
 *
 * For OAuth flows initiated via /auth/sign-in/google, Supabase forwards a
 * `state` query param. We look the verifier up from `auth_pkce_state` by
 * state, manually POST to Supabase's /auth/v1/token endpoint, and use
 * setSession to write the resulting session cookies. No cookie-based PKCE
 * verifier — sidesteps Brave Shields entirely.
 *
 * For magic-link flows (no `state` param), we fall back to the standard
 * supabase.auth.exchangeCodeForSession path — that flow's cookie is set on a
 * same-origin redirect so Brave should accept it. Cross-browser email
 * clicks are a structural OAuth-PKCE-via-email limitation and remain a
 * deferred Phase B item (token-hash flow + email template change).
 */

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

function getOriginSafe(request: Request): string {
  try {
    return getOrigin(request);
  } catch {
    const fwd = request.headers.get("x-forwarded-host");
    return fwd ? `https://${fwd}` : "https://klirs.eu";
  }
}

async function exchangeCodeWithStoredVerifier(
  code: string,
  state: string
): Promise<
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; reason: string }
> {
  const admin = createAdminClient();
  const { data: row, error: lookupError } = await admin
    .from("auth_pkce_state")
    .select("code_verifier, expires_at")
    .eq("state", state)
    .maybeSingle();

  if (lookupError) {
    return { ok: false, reason: `state_lookup: ${lookupError.message}` };
  }
  if (!row) {
    return { ok: false, reason: "state_not_found" };
  }
  if (new Date(row.expires_at) < new Date()) {
    // Best-effort cleanup; ignore errors.
    await admin.from("auth_pkce_state").delete().eq("state", state);
    return { ok: false, reason: "state_expired" };
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const tokenRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=pkce`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    },
    body: JSON.stringify({ auth_code: code, code_verifier: row.code_verifier }),
  });

  // One-shot use: delete the state row regardless of outcome (replay protection).
  await admin.from("auth_pkce_state").delete().eq("state", state);

  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => "");
    return {
      ok: false,
      reason: `token_exchange ${tokenRes.status}: ${text.slice(0, 200)}`,
    };
  }
  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (!tokens.access_token || !tokens.refresh_token) {
    return { ok: false, reason: "token_response_missing_tokens" };
  }
  return {
    ok: true,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  };
}

export async function GET(request: Request) {
  const origin = getOriginSafe(request);
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");
    // `ks` (klirs state) is embedded in redirect_to by /auth/sign-in/google
    // and round-trips back to us preserved. Distinct from OAuth-spec `state`
    // which Supabase manages internally for CSRF and rejects if we forge.
    const ks = searchParams.get("ks");

    if (!code) {
      console.error("[auth/callback] no_code", {
        forwardedHost: request.headers.get("x-forwarded-host"),
        host: request.headers.get("host"),
      });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent("no_code")}`
      );
    }

    const supabase = await createClient();

    if (ks) {
      // OAuth path — server-managed PKCE state (Brave-compatible).
      const result = await exchangeCodeWithStoredVerifier(code, ks);
      if (!result.ok) {
        console.error("[auth/callback] pkce_exchange_failed", {
          reason: result.reason,
        });
        return NextResponse.redirect(
          `${origin}/login?error=auth_failed&detail=${encodeURIComponent(result.reason)}`
        );
      }
      const { error: setSessionError } = await supabase.auth.setSession({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
      });
      if (setSessionError) {
        console.error("[auth/callback] set_session_failed", {
          message: setSessionError.message,
        });
        return NextResponse.redirect(
          `${origin}/login?error=auth_failed&detail=${encodeURIComponent(`set_session: ${setSessionError.message}`)}`
        );
      }
    } else {
      // Magic-link path — standard cookie-based exchange.
      // The cookie was set on a same-origin redirect (klirs.eu/auth/sign-in/email →
      // klirs.eu/login?sent=…) so Brave Shields shouldn't have flagged it.
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        console.error("[auth/callback] exchange_failed", {
          message: error.message,
          status: error.status,
        });
        return NextResponse.redirect(
          `${origin}/login?error=auth_failed&detail=${encodeURIComponent(error.message)}`
        );
      }
    }

    // Sync profile name from auth metadata.
    const {
      data: { user },
      error: getUserError,
    } = await supabase.auth.getUser();
    if (getUserError || !user) {
      console.error("[auth/callback] getUser_failed_after_exchange", {
        message: getUserError?.message,
        hasUser: !!user,
      });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent(getUserError?.message ?? "no_user_after_exchange")}`
      );
    }

    const name = user.user_metadata?.full_name || user.user_metadata?.name;
    const email = user.email;
    const { error: upsertError } = await supabase.from("profiles").upsert(
      {
        id: user.id,
        full_name: name || email?.split("@")[0] || "User",
        email,
      },
      { onConflict: "id" }
    );
    if (upsertError) {
      console.error("[auth/callback] profile_upsert_failed", {
        message: upsertError.message,
        code: upsertError.code,
      });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent(`profile_upsert: ${upsertError.message}`)}`
      );
    }

    return NextResponse.redirect(`${origin}/dashboard`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error("[auth/callback] unhandled_throw", {
      name,
      message,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.redirect(
      `${origin}/login?error=auth_failed&detail=${encodeURIComponent(`unhandled: ${name}: ${message}`)}`
    );
  }
}
