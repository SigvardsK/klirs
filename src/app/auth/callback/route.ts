import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

function getOrigin(request: Request): string {
  // Use forwarded headers (Railway, Vercel, etc.) over internal request URL
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  const host = request.headers.get("host");
  if (host && !host.startsWith("0.0.0.0") && !host.startsWith("127.0.0.1")) {
    return `${forwardedProto}://${host}`;
  }
  return new URL(request.url).origin;
}

export async function GET(request: Request) {
  // Top-level try/catch is load-bearing for the diagnostic mission: if
  // createClient() throws (env var missing, cookie parse), or if Supabase's
  // exchangeCodeForSession *throws* rather than returning {error}, we still
  // want the failure surfaced via ?detail= rather than landing on a generic
  // Next.js 500 page with no clue what happened. Without this wrapper the
  // entire diagnostic instrumentation is bypassable by any unhandled throw.
  const origin = getOriginSafe(request);
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");

    if (!code) {
      console.error("[auth/callback] no_code", {
        url: request.url,
        forwardedHost: request.headers.get("x-forwarded-host"),
        forwardedProto: request.headers.get("x-forwarded-proto"),
        host: request.headers.get("host"),
      });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent("no_code")}`
      );
    }

    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      console.error("[auth/callback] exchange_failed", {
        message: error.message,
        status: error.status,
        name: error.name,
        origin,
      });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent(error.message)}`
      );
    }

    // Sync profile name from OAuth metadata
    const { data: { user }, error: getUserError } = await supabase.auth.getUser();
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

    const { error: upsertError } = await supabase
      .from("profiles")
      .upsert({
        id: user.id,
        full_name: name || email?.split("@")[0] || "User",
        email: email,
      }, { onConflict: "id" });

    if (upsertError) {
      console.error("[auth/callback] profile_upsert_failed", {
        message: upsertError.message,
        code: upsertError.code,
        userId: user.id,
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

// getOrigin variant that swallows its own errors (the URL-parsing fallback in
// getOrigin throws if request.url is malformed). Used only by the top-level
// catch — a normal request takes the original code path.
function getOriginSafe(request: Request): string {
  try {
    return getOrigin(request);
  } catch {
    const fwd = request.headers.get("x-forwarded-host");
    return fwd ? `https://${fwd}` : "https://klirs.eu";
  }
}
