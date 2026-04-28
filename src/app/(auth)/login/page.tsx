"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Shield } from "lucide-react";
import Link from "next/link";

function LoginContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error");
  const [loading, setLoading] = useState(false);

  const handleGoogleLogin = async () => {
    setLoading(true);
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
      },
    });
  };

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center justify-center gap-3 mb-8">
          <Shield className="w-8 h-8 text-emerald-500" />
          <span className="text-2xl font-bold text-white">AML Screening</span>
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
            </div>
          )}

          <Button
            onClick={handleGoogleLogin}
            disabled={loading}
            variant="outline"
            className="w-full border-white/10 bg-white text-slate-900 hover:bg-slate-200 font-medium h-11 rounded-xl"
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
            {loading ? "Redirecting..." : "Sign in with Google"}
          </Button>

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
          <Link href="/demo" className="text-sm text-emerald-400 hover:text-emerald-300 transition-colors">
            View sample screening report &rarr;
          </Link>
          <p className="text-xs text-slate-600">
            Powered by automated compliance screening technology
          </p>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-950 flex items-center justify-center">
          <p className="text-slate-400">Loading...</p>
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
