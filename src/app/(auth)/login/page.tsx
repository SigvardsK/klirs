import { Suspense } from "react";
import { Mail, Shield } from "lucide-react";
import Link from "next/link";

interface SearchParamsShape {
  error?: string;
  detail?: string;
  sent?: string;
}

// Server component — reads searchParams directly, no client state needed.
// Auth is now initiated via plain HTML form POSTs to the server-side
// /auth/sign-in/google and /auth/sign-in/email route handlers, which write
// the PKCE verifier through @supabase/ssr's canonical response-cookie path.
// The previous client-side createClient().auth.signInWith* calls produced
// "PKCE code verifier not found in storage" on the callback (likely an
// async cookie-flush race against the top-level navigation); this rewrite
// sidesteps that entirely.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsShape>;
}) {
  const params = await searchParams;
  const error = params.error;
  const errorDetail = params.detail;
  const magicSentTo = params.sent;

  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 flex items-center justify-center">
          <p className="text-slate-400">Loading...</p>
        </div>
      }
    >
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          {/* Logo */}
          <div className="flex items-center justify-center gap-3 mb-8">
            <Shield className="w-8 h-8 text-emerald-500" />
            <span className="text-2xl font-bold text-white">Klirs</span>
          </div>

          {/* Card */}
          <div className="bg-slate-900 rounded-2xl border border-white/10 p-8">
            <h1 className="text-xl font-semibold text-white text-center mb-2">
              Compliance Screening Portal
            </h1>
            <p className="text-sm text-slate-400 text-center mb-6">
              Automated KYC/AML screening across 8+ international databases
            </p>

            {error && (
              <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 mb-4">
                <p className="text-sm text-red-400 text-center">
                  {error === "auth_failed"
                    ? "Authentication failed. Please try again."
                    : "An error occurred. Please try again."}
                </p>
                {errorDetail && (
                  <p className="text-[10px] text-red-300/60 text-center mt-1.5 font-mono break-all">
                    {errorDetail}
                  </p>
                )}
              </div>
            )}

            {magicSentTo ? (
              <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 mb-4">
                <Mail className="w-5 h-5 text-emerald-400 mx-auto mb-2" />
                <p className="text-sm text-emerald-300 text-center mb-1">
                  Check your email
                </p>
                <p className="text-xs text-slate-400 text-center">
                  We sent a sign-in link to{" "}
                  <strong className="text-slate-200">{magicSentTo}</strong>. Open it on this device to continue.
                </p>
                <Link
                  href="/login"
                  className="text-xs text-slate-500 hover:text-emerald-400 transition-colors mt-3 mx-auto block text-center"
                >
                  Use a different email
                </Link>
              </div>
            ) : (
              <form
                action="/auth/sign-in/email"
                method="POST"
                className="space-y-3 mb-4"
              >
                <input
                  type="email"
                  name="email"
                  required
                  placeholder="you@firm.com"
                  autoComplete="email"
                  className="flex w-full h-11 rounded-xl bg-slate-800 border border-white/10 text-white placeholder:text-slate-500 px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
                />
                <button
                  type="submit"
                  className="inline-flex items-center justify-center w-full h-11 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-sm transition-colors"
                >
                  Send sign-in link
                </button>
              </form>
            )}

            {!magicSentTo && (
              <>
                <div className="flex items-center gap-3 text-xs text-slate-600 my-4">
                  <div className="h-px flex-1 bg-white/10" />
                  <span>or</span>
                  <div className="h-px flex-1 bg-white/10" />
                </div>

                <form action="/auth/sign-in/google" method="POST">
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center w-full h-11 rounded-xl border border-white/10 bg-white hover:bg-slate-200 text-slate-900 font-medium text-sm transition-colors"
                  >
                    <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
                      <path
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                        fill="#4285F4"
                      />
                      <path
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        fill="#34A853"
                      />
                      <path
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        fill="#FBBC05"
                      />
                      <path
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        fill="#EA4335"
                      />
                    </svg>
                    Sign in with Google
                  </button>
                </form>
              </>
            )}

            <div className="mt-6 space-y-2">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Sanctions screening (EU, US, UK, UN)
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                PEP & politically exposed persons checks
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Adverse media screening (4 languages)
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Company registry verification
              </div>
            </div>
          </div>

          <div className="text-center mt-6 space-y-2">
            <Link
              href="/demo"
              className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              View sample screening report &rarr;
            </Link>
            <p className="text-xs text-slate-600">
              Powered by automated compliance screening technology
            </p>
          </div>
        </div>
      </div>
    </Suspense>
  );
}
