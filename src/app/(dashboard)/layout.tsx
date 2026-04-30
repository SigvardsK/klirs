import { getCurrentUserProfile } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Shield, LogOut } from "lucide-react";
import { SignOutButton } from "@/components/sign-out-button";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUserProfile();
  if (!user) redirect("/login");

  return (
    <div className="min-h-screen bg-slate-950">
      {/* Header */}
      <header className="border-b border-white/10 bg-slate-900/50 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="w-6 h-6 text-emerald-500" />
            <span className="text-lg font-semibold text-white">Klirs</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-slate-400">{user.full_name}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}
