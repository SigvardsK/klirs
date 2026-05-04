import { NextResponse, type NextRequest } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/lib/i18n/routing";
import { updateSession } from "@/lib/supabase/middleware";

const handleI18n = createIntlMiddleware(routing);

const MARKETING_PATH = /^\/(lv(\/.*)?)?$/;

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Bail middleware on /auth/* paths. The auth callback route reads the PKCE
  // verifier cookie set during OAuth/OTP initiation; running updateSession
  // here causes a getUser() call that can race with the verifier cookie's
  // round-trip and clobber it. The auth flow handles its own cookie state
  // via the route handlers + server-side @supabase/ssr client. (Pattern
  // mirrors chief-of-staff/src/middleware.ts which works.)
  if (pathname.startsWith("/auth")) {
    return;
  }

  if (MARKETING_PATH.test(pathname)) {
    if (process.env.NEXT_PUBLIC_SUPABASE_URL) {
      const supabaseResponse = await updateSession(request);
      if (
        supabaseResponse instanceof NextResponse &&
        supabaseResponse.headers.get("location")
      ) {
        return supabaseResponse;
      }
    }
    return handleI18n(request);
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return;
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
