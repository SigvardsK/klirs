import Link from "next/link";
import { Clock, ArrowRight } from "lucide-react";

/**
 * Rendered when /screen/[id] resolves to no screening — either the id never
 * existed, or it's past the 24h retention window for demo trials. We surface
 * this as informational (not 404) so the buyer learns the public-window
 * contract: trial results are 24h public, then garbage-collected.
 */
export function ScreenExpired() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background text-foreground px-6">
      <div className="max-w-lg w-full text-center space-y-6">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-muted text-muted-foreground">
          <Clock className="w-7 h-7" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            This trial result has expired
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Klirs trial results are public for 24 hours, then garbage-collected.
            Run a fresh screening — it takes about a minute.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          <Link
            href="/"
            className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity"
          >
            Run a new screening
            <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/login"
            className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-md border border-border bg-card text-foreground font-medium text-sm hover:bg-muted transition-colors"
          >
            Sign in to save results
          </Link>
        </div>
      </div>
    </div>
  );
}
