import { Shield, ArrowRight, Code, ExternalLink } from "lucide-react";
import Link from "next/link";
import { DemoTrial } from "@/components/demo-trial";

const GITHUB_HREF = "https://github.com/SigvardsK/klirs";

export default function DemoPage() {
  return (
    <div className="min-h-screen bg-slate-950">
      {/* Header */}
      <header className="border-b border-white/10 bg-slate-900/50 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-3">
            <Shield className="w-6 h-6 text-emerald-500" />
            <span className="text-lg font-semibold text-white">Klirs</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <a
              href={GITHUB_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:inline-flex items-center gap-1.5 text-slate-400 hover:text-emerald-400 transition-colors"
            >
              <Code className="w-4 h-4" />
              Source on GitHub
              <ExternalLink className="w-3 h-3" />
            </a>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 text-emerald-400 hover:text-emerald-300 transition-colors"
            >
              Sign In
              <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <DemoTrial />
      </main>
    </div>
  );
}
