import { createClient } from "@/lib/supabase/server";
import { getCurrentUserProfile } from "@/lib/auth";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Plus, Shield, Clock, CheckCircle, AlertTriangle, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Screening } from "@/lib/types";
import { isSuperuserEmail, DEMO_LIMIT, DEMO_CONTACT_HREF } from "@/lib/constants";

const statusConfig = {
  pending: { label: "Pending", variant: "secondary" as const, icon: Clock },
  in_progress: { label: "In Progress", variant: "default" as const, icon: Clock },
  completed: { label: "Completed", variant: "default" as const, icon: CheckCircle },
  failed: { label: "Failed", variant: "destructive" as const, icon: XCircle },
};

export default async function DashboardPage() {
  const user = await getCurrentUserProfile();
  if (!user) redirect("/login");

  const supabase = await createClient();
  const { data: screenings } = await supabase
    .from("screenings")
    .select("*")
    .eq("created_by", user.id)
    .order("created_at", { ascending: false });

  const typedScreenings = (screenings || []) as Screening[];
  const isSuperuser = isSuperuserEmail(user.email);
  const hasUsedDemo = !isSuperuser && typedScreenings.length >= DEMO_LIMIT;

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Screenings</h1>
          <p className="text-sm text-slate-400 mt-1">
            AML/KYC compliance screening results
          </p>
        </div>
        {!hasUsedDemo ? (
          <Link href="/screenings/new">
            <Button className="bg-emerald-600 hover:bg-emerald-700 text-white">
              <Plus className="w-4 h-4 mr-2" />
              New Screening
            </Button>
          </Link>
        ) : (
          <div className="flex items-center gap-3">
            <Button
              disabled
              className="bg-slate-800 text-slate-500 cursor-not-allowed"
              title={`Demo limit reached (${DEMO_LIMIT} screenings) — email us about a pilot`}
            >
              <Plus className="w-4 h-4 mr-2" />
              New Screening
            </Button>
          </div>
        )}
      </div>

      {typedScreenings.length === 0 ? (
        <div className="bg-slate-900 rounded-2xl border border-white/10 p-12 text-center">
          <Shield className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-white mb-2">
            Start Your First Screening
          </h2>
          <p className="text-sm text-slate-400 max-w-md mx-auto mb-6">
            Enter a company or individual&apos;s details and our system will automatically
            screen them across 8+ international databases.
          </p>
          <Link href="/screenings/new">
            <Button className="bg-emerald-600 hover:bg-emerald-700 text-white">
              <Plus className="w-4 h-4 mr-2" />
              New Screening
            </Button>
          </Link>
          <Link href="/demo" className="text-sm text-slate-400 hover:text-emerald-400 transition-colors">
            View sample report &rarr;
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {typedScreenings.map((screening) => {
            const config = statusConfig[screening.status];
            const StatusIcon = config.icon;
            return (
              <Link key={screening.id} href={`/screenings/${screening.id}`}>
                <div className="bg-slate-900 rounded-xl border border-white/10 p-4 hover:border-emerald-500/30 transition-colors cursor-pointer">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <StatusIcon className={`w-5 h-5 ${
                        screening.status === "completed" ? "text-emerald-500" :
                        screening.status === "failed" ? "text-red-500" :
                        "text-slate-400"
                      }`} />
                      <div>
                        <h3 className="text-white font-medium">{screening.entity_name}</h3>
                        <p className="text-xs text-slate-500">
                          {screening.entity_type === "company" ? "Company" : "Individual"}
                          {" · "}
                          {screening.jurisdiction}
                          {screening.persons?.length > 0 && ` · ${screening.persons.length} person(s)`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {screening.status === "in_progress" && (
                        <span className="text-xs text-slate-400">
                          {screening.checks_completed}/{screening.checks_total} checks
                        </span>
                      )}
                      <Badge variant={config.variant} className={
                        screening.status === "completed" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                        screening.status === "in_progress" ? "bg-blue-500/10 text-blue-400 border-blue-500/20" :
                        ""
                      }>
                        {config.label}
                      </Badge>
                      <span className="text-xs text-slate-600">
                        {new Date(screening.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}

          {/* Gate wall after DEMO_LIMIT reached */}
          {hasUsedDemo && (
            <div className="bg-slate-900/50 rounded-xl border border-amber-500/30 p-6 mt-6">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <h3 className="text-white font-medium mb-1">
                    Demo Limit Reached ({DEMO_LIMIT} screenings)
                  </h3>
                  <p className="text-sm text-slate-400 mb-4 leading-relaxed">
                    You&rsquo;ve used your {DEMO_LIMIT} free screenings. Drop us a line
                    and we&rsquo;ll get you set up with a pilot — full access, no
                    watermarks, audit-ready evidence bundles.
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <a
                      href={DEMO_CONTACT_HREF}
                      className="inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-medium px-4 py-2 rounded-md text-sm transition-colors"
                    >
                      Email us about a pilot →
                    </a>
                    <Link
                      href="/demo"
                      className="inline-flex items-center text-sm text-slate-400 hover:text-emerald-400 transition-colors"
                    >
                      View sample report &rarr;
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
