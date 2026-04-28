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
  const { searchParams } = new URL(request.url);
  const origin = getOrigin(request);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Sync profile name from OAuth metadata
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const name = user.user_metadata?.full_name || user.user_metadata?.name;
        const email = user.email;

        await supabase
          .from("profiles")
          .upsert({
            id: user.id,
            full_name: name || email?.split("@")[0] || "User",
            email: email,
          }, { onConflict: "id" });
      }

      return NextResponse.redirect(`${origin}/dashboard`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth_failed`);
}
