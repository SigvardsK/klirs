import type messages from "./messages/en.json";

declare module "next-intl" {
  interface AppConfig {
    Locale: "en" | "lv";
    Messages: typeof messages;
  }
}
