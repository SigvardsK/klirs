import Link from "next/link";
import Image from "next/image";
import {
  Shield,
  ArrowRight,
  FileCheck,
  Globe,
  Lock,
  Code,
  ExternalLink,
  Scale,
  Briefcase,
  Coins,
  Database,
  Calendar,
} from "lucide-react";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/lib/i18n/routing";
import LocaleSwitcher from "@/components/locale-switcher";
import { ProductShowcase } from "@/components/product-showcase";
import { ThemeToggle } from "@/components/theme-toggle";
import { LandingHeroForm } from "@/components/landing-hero-form";

const GITHUB_HREF = "https://github.com/SigvardsK/klirs";
// Set NEXT_PUBLIC_BOOKING_URL on Railway to your Google Calendar appointment-scheduling link.
// Mailto fallback ensures the CTA never 404s if the env var is missing.
const BOOKING_URL =
  process.env.NEXT_PUBLIC_BOOKING_URL ||
  "mailto:sigvards.krongorns@gmail.com?subject=Book%20a%20Klirs%20demo";

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
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/50 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className="w-6 h-6 text-emerald-600 dark:text-emerald-500" />
            <span className="text-lg font-semibold">{t("common.brand")}</span>
          </div>
          <nav className="flex items-center gap-4 sm:gap-6 text-sm">
            <a
              href={GITHUB_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 inline-flex items-center gap-1.5 transition-colors"
            >
              <Code className="w-4 h-4" />
              <span className="hidden sm:inline">{t("common.github")}</span>
            </a>
            <Link
              href="/login"
              className="text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
            >
              {t("common.signIn")}
            </Link>
            <LocaleSwitcher />
            <ThemeToggle
              toLightLabel={t("common.themeToggleToLight")}
              toDarkLabel={t("common.themeToggleToDark")}
            />
          </nav>
        </div>
      </header>

      <main>
        {/* Hero — form-as-hero with subtle architectural backdrop. Fills the
            initial viewport (minus header) so the form occupies the first
            impression entirely; marketing content peeks in only on scroll.
            The hero-bg image sits behind a strong gradient overlay so the
            form stays the visual focal point. */}
        <section className="relative isolate overflow-hidden min-h-[calc(100vh-4rem)] flex flex-col">
          <div className="absolute inset-0 -z-10" aria-hidden="true">
            <Image
              src="/imagery/hero-bg.webp"
              alt=""
              fill
              priority
              sizes="100vw"
              className="object-cover opacity-25 dark:opacity-15"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-background/70 via-background/90 to-background" />
          </div>
          <div className="flex-1 max-w-3xl w-full mx-auto px-4 sm:px-6 lg:px-8 pt-12 sm:pt-20 pb-8 flex flex-col justify-center">
          <p className="text-xs sm:text-sm uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-medium mb-4">
            {t("hero.eyebrow")}
          </p>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight leading-tight">
            {t("hero.title")}
          </h1>
          <p className="mt-4 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-2xl">
            {t("hero.subhead")}
          </p>

          <div className="mt-8 sm:mt-10">
            <LandingHeroForm
              placeholderIndividual={t("hero.formPlaceholderIndividual")}
              placeholderEntity={t("hero.formPlaceholderEntity")}
              ctaLabel={t("hero.formCTA")}
              ctaSubmittingLabel={t("hero.formSubmitting")}
              entityIndividualLabel={t("hero.formEntityIndividual")}
              entityCompanyLabel={t("hero.formEntityCompany")}
              entityHelper={t("hero.formEntityHelper")}
              companyNudge={t("hero.formCompanyNudge")}
              confirmButton={t("hero.formConfirmButton")}
              confirmRecapTemplate={t("hero.formConfirmRecap", { name: "{name}", type: "{type}" })}
              sampleLabel={t("hero.formSampleLabel")}
              sampleCleanName={t("hero.formSampleClean")}
              sampleSanctionedName={t("hero.formSampleSanctioned")}
              sampleEntityName={t("hero.formSampleEntity")}
              rateLimitedMessage={t("hero.formRateLimited")}
              genericErrorMessage={t("hero.formGenericError")}
            />
          </div>

          {/* Secondary actions — booking + GitHub kept discoverable but quieter */}
          <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
            <a
              href={BOOKING_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors"
            >
              <Calendar className="w-4 h-4" />
              {t("hero.orBookCall")}
              <ExternalLink className="w-3 h-3" />
            </a>
            <a
              href={GITHUB_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors"
            >
              <Code className="w-3.5 h-3.5" />
              {t("hero.ctaSource")}
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          </div>

          {/* Scroll hint pinned to the bottom of the viewport-filling hero */}
          <div className="pb-8 pt-4 text-center">
            <a
              href="#learn-more"
              className="inline-flex flex-col items-center gap-1 text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
            >
              {t("hero.learnMore")}
              <ArrowRight className="w-4 h-4 rotate-90" aria-hidden="true" />
            </a>
          </div>
        </section>

        {/* For whom — each card carries a photo header so the page reads as
            "professional services" not "developer tool." Cards retain their
            lucide icon as a secondary anchor on top of the photo. */}
        <section id="learn-more" className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20 scroll-mt-16">
          <h2 className="text-3xl font-semibold tracking-tight max-w-3xl">
            {t("forWhom.title")}
          </h2>
          <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="rounded-lg border border-border bg-card overflow-hidden flex flex-col">
              <div className="relative aspect-[4/3] bg-muted">
                <Image
                  src="/imagery/lawyers.webp"
                  alt=""
                  fill
                  sizes="(min-width: 768px) 33vw, 100vw"
                  className="object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-background/40 to-transparent" />
                <div className="absolute top-3 left-3 inline-flex items-center justify-center w-10 h-10 rounded-md bg-background/85 backdrop-blur-sm shadow-sm">
                  <Scale className="w-5 h-5 text-emerald-600 dark:text-emerald-500" />
                </div>
              </div>
              <div className="p-6">
                <h3 className="text-lg font-semibold">
                  {t("forWhom.advokatiTitle")}
                </h3>
                <p className="mt-2 text-muted-foreground leading-relaxed">
                  {t("forWhom.advokatiBody")}
                </p>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card overflow-hidden flex flex-col">
              <div className="relative aspect-[4/3] bg-muted">
                <Image
                  src="/imagery/compliance.webp"
                  alt=""
                  fill
                  sizes="(min-width: 768px) 33vw, 100vw"
                  className="object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-background/40 to-transparent" />
                <div className="absolute top-3 left-3 inline-flex items-center justify-center w-10 h-10 rounded-md bg-background/85 backdrop-blur-sm shadow-sm">
                  <Briefcase className="w-5 h-5 text-emerald-600 dark:text-emerald-500" />
                </div>
              </div>
              <div className="p-6">
                <h3 className="text-lg font-semibold">
                  {t("forWhom.complianceTitle")}
                </h3>
                <p className="mt-2 text-muted-foreground leading-relaxed">
                  {t("forWhom.complianceBody")}
                </p>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card overflow-hidden flex flex-col">
              <div className="relative aspect-[4/3] bg-muted">
                <Image
                  src="/imagery/accountants.webp"
                  alt=""
                  fill
                  sizes="(min-width: 768px) 33vw, 100vw"
                  className="object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-background/40 to-transparent" />
                <div className="absolute top-3 left-3 inline-flex items-center justify-center w-10 h-10 rounded-md bg-background/85 backdrop-blur-sm shadow-sm">
                  <Coins className="w-5 h-5 text-emerald-600 dark:text-emerald-500" />
                </div>
              </div>
              <div className="p-6">
                <h3 className="text-lg font-semibold">
                  {t("forWhom.vaspTitle")}
                </h3>
                <p className="mt-2 text-muted-foreground leading-relaxed">
                  {t("forWhom.vaspBody")}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Registers / compliance reality anchor — split layout with a
            modest workspace image on the right (desktop) / above (mobile)
            so the section breathes against the dense data-source enumeration. */}
        <section className="border-y border-border bg-card/60">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-8 md:gap-12 items-center">
              <div className="md:col-span-3 flex items-start gap-4 order-2 md:order-1">
                <Database className="w-8 h-8 text-emerald-600 dark:text-emerald-500 shrink-0 mt-1" />
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight">
                    {t("registers.title")}
                  </h2>
                  <p className="mt-3 text-muted-foreground leading-relaxed">
                    {t("registers.body")}
                  </p>
                </div>
              </div>
              <div className="md:col-span-2 order-1 md:order-2">
                <div className="relative aspect-[3/2] rounded-lg overflow-hidden border border-border shadow-sm">
                  <Image
                    src="/imagery/registers.webp"
                    alt=""
                    fill
                    sizes="(min-width: 768px) 40vw, 100vw"
                    className="object-cover"
                  />
                </div>
              </div>
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
              <FileCheck className="w-8 h-8 text-emerald-600 dark:text-emerald-500" />
              <h3 className="mt-4 text-lg font-semibold">
                {t("features.evidenceTitle")}
              </h3>
              <p className="mt-2 text-muted-foreground leading-relaxed">
                {t("features.evidenceBody")}
              </p>
            </div>
            <div>
              <Globe className="w-8 h-8 text-emerald-600 dark:text-emerald-500" />
              <h3 className="mt-4 text-lg font-semibold">
                {t("features.coverageTitle")}
              </h3>
              <p className="mt-2 text-muted-foreground leading-relaxed">
                {t("features.coverageBody")}
              </p>
            </div>
            <div>
              <Lock className="w-8 h-8 text-emerald-600 dark:text-emerald-500" />
              <h3 className="mt-4 text-lg font-semibold">
                {t("features.annexTitle")}
              </h3>
              <p className="mt-2 text-muted-foreground leading-relaxed">
                {t("features.annexBody")}
              </p>
            </div>
          </div>
        </section>

        {/* Product showcase */}
        <section className="border-y border-border bg-card/60">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
            <div className="max-w-3xl mb-12">
              <h2 className="text-3xl font-semibold tracking-tight">
                {t("productShowcase.title")}
              </h2>
            </div>
            <ProductShowcase
              images={[
                {
                  src: "/screenshots/analysis.png",
                  alt: "Analysis tab — risk score and breakdown",
                  caption: t("productShowcase.captions.analysis"),
                },
                {
                  src: "/screenshots/checks.png",
                  alt: "Checks tab — multi-source coverage",
                  caption: t("productShowcase.captions.checks"),
                },
                {
                  src: "/screenshots/summary.png",
                  alt: "Summary with pre-filled compliance documentation",
                  caption: t("productShowcase.captions.summary"),
                },
              ]}
            />
          </div>
        </section>

        {/* CTA — wide conference-room inset behind the call to action.
            The image sits above the copy on mobile, beside it on desktop. */}
        <section className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-24">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16 items-center">
            <div className="relative aspect-[16/10] rounded-lg overflow-hidden border border-border shadow-sm order-2 lg:order-1">
              <Image
                src="/imagery/cta.webp"
                alt=""
                fill
                sizes="(min-width: 1024px) 50vw, 100vw"
                className="object-cover"
              />
            </div>
            <div className="order-1 lg:order-2">
              <h2 className="text-3xl font-semibold tracking-tight">
                {t("cta.title")}
              </h2>
              <p className="mt-4 text-muted-foreground leading-relaxed">{t("cta.body")}</p>
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <a
                  href={BOOKING_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white dark:text-slate-950 font-semibold px-6 py-3 rounded-md transition-colors"
                >
                  <Calendar className="w-4 h-4" />
                  {t("cta.bookButton")}
                </a>
                <Link
                  href="/login"
                  className="inline-flex items-center gap-2 border border-border hover:border-emerald-600/50 dark:hover:border-emerald-500/50 hover:text-emerald-700 dark:hover:text-emerald-400 px-6 py-3 rounded-md transition-colors"
                >
                  {t("cta.tryButton")}
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-card/40">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-10 text-sm text-muted-foreground">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-600 dark:text-emerald-500" />
              <span>{t("footer.tagline")}</span>
            </div>
            <div className="flex items-center gap-6">
              <a
                href={GITHUB_HREF}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
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
