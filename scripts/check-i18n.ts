import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Json = string | number | boolean | null | { [k: string]: Json } | Json[];

const MESSAGES_DIR = resolve(process.cwd(), "src/lib/i18n/messages");
const SOURCE_LOCALE = "en";
const TARGET_LOCALES = ["lv"] as const;

function load(locale: string): Json {
  return JSON.parse(readFileSync(resolve(MESSAGES_DIR, `${locale}.json`), "utf8"));
}

function flatten(obj: Json, prefix = ""): string[] {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return prefix ? [prefix] : [];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const nested = flatten(v, next);
      // Empty namespace blocks (reserved-empty {} for future) — record the prefix as a no-op key
      if (nested.length === 0) {
        out.push(next);
      } else {
        out.push(...nested);
      }
    } else {
      out.push(next);
    }
  }
  return out;
}

function getAt(obj: Json, path: string): Json | undefined {
  return path.split(".").reduce<Json | undefined>((acc, key) => {
    if (acc === undefined || acc === null || typeof acc !== "object" || Array.isArray(acc)) {
      return undefined;
    }
    return (acc as { [k: string]: Json })[key];
  }, obj);
}

function isMissing(value: Json | undefined): boolean {
  if (value === undefined) return true;
  // Empty namespace block (reserved {}) is acceptable — counts as present
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return false;
  }
  return value === "" || value === null;
}

let failed = false;
const source = load(SOURCE_LOCALE);
const sourceKeys = flatten(source);

for (const locale of TARGET_LOCALES) {
  const target = load(locale);
  const missing: string[] = [];
  for (const key of sourceKeys) {
    const sourceValue = getAt(source, key);
    // Skip reserved-empty namespaces in source (they exist as keys but have no content yet)
    if (
      sourceValue !== null &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      Object.keys(sourceValue).length === 0
    ) {
      continue;
    }
    if (isMissing(getAt(target, key))) {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    failed = true;
    console.error(`[check-i18n] ${locale}.json missing or empty keys (${missing.length}):`);
    for (const k of missing) console.error(`  - ${k}`);
  } else {
    console.log(`[check-i18n] ${locale}.json: OK (${sourceKeys.length} keys)`);
  }
}

if (failed) process.exit(1);
