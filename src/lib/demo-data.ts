/**
 * Pre-built demo screening data for Air Baltic Corporation.
 * Used by the public /demo page to showcase a complete screening report.
 */

import type { Screening, ScreeningCheck } from "./types";
import { SEARCHABLE_DATABASES, COMPANY_REGISTRY_CONFIG } from "./db-configs";

const DEMO_ENTITY = "AS Air Baltic Corporation";
const DEMO_REG_NO = "40003245752";
const DEMO_PERSONS = [
  { name: "Erno Hilden", role: "CEO" },
  { name: "Andrejs Martinovs", role: "Supervisory Board Chairman" },
  { name: "Jurģis Sedlenieks", role: "Supervisory Board Member" },
];

const DEMO_BASE_TIME = new Date("2026-04-11T09:00:00Z");

function demoTimestamp(offsetMinutes: number): string {
  return new Date(DEMO_BASE_TIME.getTime() + offsetMinutes * 60_000).toISOString();
}

function buildDemoChecks(): ScreeningCheck[] {
  const checks: ScreeningCheck[] = [];
  let idx = 0;
  let minuteOffset = 0;

  // Searchable databases
  for (const db of SEARCHABLE_DATABASES) {
    if (db.personsOnly) {
      for (const person of DEMO_PERSONS) {
        checks.push({
          id: `demo-${idx++}`,
          screening_id: "demo",
          database_name: db.name,
          category: db.category,
          search_term: person.name,
          status: "clear",
          screenshot_path: null,
          details: null,
          source_url: null,
          checked_at: demoTimestamp(minuteOffset++),
        });
      }
    } else if (db.companyOnly) {
      checks.push({
        id: `demo-${idx++}`,
        screening_id: "demo",
        database_name: db.name,
        category: db.category,
        search_term: DEMO_ENTITY,
        status: "clear",
        screenshot_path: null,
        details: null,
          source_url: null,
        checked_at: demoTimestamp(minuteOffset++),
      });
    } else {
      // Entity + each person
      checks.push({
        id: `demo-${idx++}`,
        screening_id: "demo",
        database_name: db.name,
        category: db.category,
        search_term: DEMO_ENTITY,
        status: "clear",
        screenshot_path: null,
        details: null,
          source_url: null,
        checked_at: demoTimestamp(minuteOffset++),
      });
      for (const person of DEMO_PERSONS) {
        checks.push({
          id: `demo-${idx++}`,
          screening_id: "demo",
          database_name: db.name,
          category: db.category,
          search_term: person.name,
          status: "clear",
          screenshot_path: null,
          details: null,
          source_url: null,
          checked_at: demoTimestamp(minuteOffset++),
        });
      }
    }
  }

  // Adverse media: each person × 4 languages
  const languages = ["LV", "EN", "ET", "RU"];
  for (const person of DEMO_PERSONS) {
    for (const lang of languages) {
      checks.push({
        id: `demo-${idx++}`,
        screening_id: "demo",
        database_name: `Adverse Media (${lang})`,
        category: "adverse_media",
        search_term: `${person.name} (${lang})`,
        status: "clear",
        screenshot_path: null,
        details: null,
          source_url: null,
        checked_at: demoTimestamp(minuteOffset++),
      });
    }
  }

  // Company registry (2 checks: search + detail)
  checks.push({
    id: `demo-${idx++}`,
    screening_id: "demo",
    database_name: `${COMPANY_REGISTRY_CONFIG.name} — Search`,
    category: "company_registry",
    search_term: DEMO_ENTITY,
    status: "clear",
    screenshot_path: null,
    details: null,
          source_url: null,
    checked_at: demoTimestamp(minuteOffset++),
  });
  checks.push({
    id: `demo-${idx++}`,
    screening_id: "demo",
    database_name: `${COMPANY_REGISTRY_CONFIG.name} — Detail`,
    category: "company_registry",
    search_term: DEMO_ENTITY,
    status: "clear",
    screenshot_path: null,
    details: null,
          source_url: null,
    checked_at: demoTimestamp(minuteOffset++),
  });

  return checks;
}

export const DEMO_CHECKS = buildDemoChecks();

export const DEMO_SCREENING: Screening = {
  id: "demo",
  created_by: "demo",
  entity_name: DEMO_ENTITY,
  entity_type: "company",
  jurisdiction: "Latvia",
  registration_number: DEMO_REG_NO,
  persons: DEMO_PERSONS,
  status: "completed",
  checks_total: DEMO_CHECKS.length,
  checks_completed: DEMO_CHECKS.length,
  is_demo: true,
  created_at: demoTimestamp(0),
  completed_at: demoTimestamp(DEMO_CHECKS.length),
};
