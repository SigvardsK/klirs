/**
 * Server-side Google OAuth initiation.
 *
 * Why server-side: the PKCE flow stores a code verifier that must survive the
 * round-trip to Google's consent screen and back to /auth/callback. The
 * client-side @supabase/ssr `createBrowserClient` writes the verifier to
 * document.cookie, but production traces showed the verifier going missing on
 * the callback (`PKCE code verifier not found in storage`) — likely an async
 * cookie-flush race against the top-level navigation `signInWithOAuth`
 * triggers internally. Initiating server-side writes the verifier through the
 * server-side response-cookie path (the canonical, well-tested route in
 * @supabase/ssr) and sidesteps the race entirely.
 *
 * The login page's Google button POSTs here as a plain HTML form. We call
 * signInWithOAuth, take the OAuth URL Supabase returns, and redirect the
 * browser there. The verifier cookie lands on this redirect response.
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
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${origin}/auth/callback`,
      },
    });
    if (error || !data?.url) {
      const message = error?.message ?? "no_oauth_url_returned";
      console.error("[auth/sign-in/google] init_failed", { message });
      return NextResponse.redirect(
        `${origin}/login?error=auth_failed&detail=${encodeURIComponent(`oauth_init: ${message}`)}`,
        303
      );
    }
    return NextResponse.redirect(data.url, 303);
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
