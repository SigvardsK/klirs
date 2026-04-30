"use client";

import { useLocale } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { routing } from "@/lib/i18n/routing";

export default function LocaleSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  function switchLocale(nextLocale: (typeof routing.locales)[number]) {
    if (nextLocale === locale || isPending) return;
    const stripped =
      pathname === `/${locale}`
        ? "/"
        : pathname.startsWith(`/${locale}/`)
          ? pathname.slice(`/${locale}`.length)
          : pathname;
    const target =
      nextLocale === routing.defaultLocale
        ? stripped || "/"
        : `/${nextLocale}${stripped === "/" ? "" : stripped}`;
    document.cookie = `NEXT_LOCALE=${nextLocale}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => {
      router.replace(target);
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-400">
      {routing.locales.map((l, i) => (
        <span key={l} className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => switchLocale(l)}
            aria-current={l === locale ? "true" : undefined}
            className={
              l === locale
                ? "text-emerald-400 font-semibold"
                : "hover:text-emerald-400"
            }
          >
            {l.toUpperCase()}
          </button>
          {i < routing.locales.length - 1 && (
            <span className="text-slate-600">|</span>
          )}
        </span>
      ))}
    </div>
  );
}
