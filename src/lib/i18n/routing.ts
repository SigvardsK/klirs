import { defineRouting } from "next-intl/routing";

export const routing = defineRouting({
  locales: ["en", "lv"],
  defaultLocale: "en",
  localePrefix: "as-needed",
});
