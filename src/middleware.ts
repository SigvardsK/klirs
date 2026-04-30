import { NextResponse, type NextRequest } from "next/server";
import createIntlMiddleware from "next-intl/middleware";
import { routing } from "@/lib/i18n/routing";
import { updateSession } from "@/lib/supabase/middleware";

const handleI18n = createIntlMiddleware(routing);

const MARKETING_PATH = /^\/(lv(\/.*)?)?$/;

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

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
