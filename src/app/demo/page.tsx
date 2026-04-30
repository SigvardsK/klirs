import { Shield, ArrowRight } from "lucide-react";
import Link from "next/link";
import { DemoScreeningViewer } from "@/components/demo-screening-viewer";

export default function DemoPage() {
  return (
    <div className="min-h-screen bg-slate-950">
      {/* Header */}
      <header className="border-b border-white/10 bg-slate-900/50 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="w-6 h-6 text-emerald-500" />
            <span className="text-lg font-semibold text-white">Klirs</span>
          </div>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 text-sm text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            Sign In
            <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <DemoScreeningViewer />
      </main>
    </div>
  );
}
