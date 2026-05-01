import Link from "next/link";
import {
  Shield,
  ArrowRight,
  FileCheck,
  Globe,
  Lock,
  Code,
  ExternalLink,
} from "lucide-react";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/lib/i18n/routing";
import LocaleSwitcher from "@/components/locale-switcher";

const TRY_OUT_HREF = "/login";
const GITHUB_HREF = "https://github.com/SigvardsK/klirs";

export default async function MarketingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  const t = await getTranslations();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-white/10 bg-slate-900/50 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="w-6 h-6 text-emerald-500" />
            <span className="text-lg font-semibold">{t("common.brand")}</span>
          </div>
          <nav className="flex items-center gap-6 text-sm">
            <a
              href={GITHUB_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="text-slate-300 hover:text-emerald-400 inline-flex items-center gap-1.5"
            >
              <Code className="w-4 h-4" /> {t("common.github")}
            </a>
            {/* Auth route i18n is deferred to actual Phase B B5. Use absolute /login. */}
            <Link href="/login" className="text-slate-300 hover:text-emerald-400">
              {t("common.signIn")}
            </Link>
            <LocaleSwitcher />
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-24">
          <div className="max-w-3xl">
            <p className="text-sm uppercase tracking-wider text-emerald-400 font-medium mb-4">
              {t("hero.eyebrow")}
            </p>
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-semibold tracking-tight leading-tight">
              {t("hero.title")}
            </h1>
            <p className="mt-6 text-lg sm:text-xl text-slate-300 leading-relaxed">
              {t("hero.subhead")}
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-4">
              <a
                href={TRY_OUT_HREF}
                className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold px-6 py-3 rounded-md transition-colors"
              >
                {t("hero.ctaPrimary")}
                <ArrowRight className="w-4 h-4" />
              </a>
              <a
                href={GITHUB_HREF}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 border border-white/15 hover:border-emerald-500/50 hover:text-emerald-400 px-6 py-3 rounded-md transition-colors"
              >
                <Code className="w-4 h-4" />
                {t("hero.ctaSecondary")}
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </div>
          </div>
        </section>

        {/* Audit-wedge */}
        <section className="border-y border-white/10 bg-slate-900/40">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
            <div className="max-w-3xl">
              <h2 className="text-3xl font-semibold tracking-tight">
                {t("audit.title")}
              </h2>
              <blockquote className="mt-6 border-l-2 border-emerald-500 pl-6 text-lg text-slate-200 leading-relaxed">
                &ldquo;{t("audit.quote")}&rdquo;
              </blockquote>
              <p className="mt-6 text-slate-300 leading-relaxed">
                {t.rich("audit.body", {
                  strong: (chunks) => <strong>{chunks}</strong>,
                  code: (chunks) => <code>{chunks}</code>,
                })}
              </p>
            </div>
          </div>
        </section>

        {/* What you get */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
          <h2 className="text-3xl font-semibold tracking-tight max-w-3xl">
            {t("features.title")}
          </h2>
          <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-8">
            <div>
              <FileCheck className="w-8 h-8 text-emerald-500" />
              <h3 className="mt-4 text-lg font-semibold">
                {t("features.evidenceTitle")}
              </h3>
              <p className="mt-2 text-slate-300 leading-relaxed">
                {t("features.evidenceBody")}
              </p>
            </div>
            <div>
              <Globe className="w-8 h-8 text-emerald-500" />
              <h3 className="mt-4 text-lg font-semibold">
                {t("features.coverageTitle")}
              </h3>
              <p className="mt-2 text-slate-300 leading-relaxed">
                {t("features.coverageBody")}
              </p>
            </div>
            <div>
              <Lock className="w-8 h-8 text-emerald-500" />
              <h3 className="mt-4 text-lg font-semibold">
                {t("features.annexTitle")}
              </h3>
              <p className="mt-2 text-slate-300 leading-relaxed">
                {t("features.annexBody")}
              </p>
            </div>
          </div>
        </section>

        {/* Demo video placeholder */}
        <section className="border-y border-white/10 bg-slate-900/40">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
            <div className="max-w-3xl">
              <h2 className="text-3xl font-semibold tracking-tight">
                {t("demoVideo.title")}
              </h2>
              <p className="mt-4 text-slate-300">{t("demoVideo.body")}</p>
              <div className="mt-8 aspect-video rounded-lg border border-white/10 bg-slate-800/50 flex items-center justify-center">
                <p className="text-slate-400 text-sm">
                  {t("demoVideo.placeholder")}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight">
              {t("cta.title")}
            </h2>
            <p className="mt-4 text-slate-300 leading-relaxed">{t("cta.body")}</p>
            <a
              href={TRY_OUT_HREF}
              className="mt-8 inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold px-6 py-3 rounded-md transition-colors"
            >
              {t("cta.button")}
              <ArrowRight className="w-4 h-4" />
            </a>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-slate-900/30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 text-sm text-slate-400">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-500" />
              <span>{t("footer.tagline")}</span>
            </div>
            <div className="flex items-center gap-6">
              <a
                href={GITHUB_HREF}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-emerald-400"
              >
                github.com/SigvardsK/klirs
              </a>
              <span>{t("footer.license")}</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
