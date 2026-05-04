export interface Profile {
  id: string;
  full_name: string | null;
  email: string | null;
  organization: string | null;
  created_at: string;
}

export interface Screening {
  id: string;
  created_by: string;
  entity_name: string;
  entity_type: "company" | "individual";
  jurisdiction: string;
  registration_number: string | null;
  persons: Person[];
  status: "pending" | "in_progress" | "completed" | "failed";
  checks_total: number;
  checks_completed: number;
  is_demo: boolean;
  created_at: string;
  completed_at: string | null;
}

export interface Person {
  name: string;
  role: string;
  aliases?: string[];
}

export type CheckStatus = "pending" | "clear" | "hit" | "uncertain" | "error";

// User-facing label for a CheckStatus. The internal string stays `uncertain` in
// the DB and engine code (minimising churn), but reviewers see "Needs
// investigation" — the phrase that actually tells them what to do with the row.
export function statusDisplayLabel(status: CheckStatus): string {
  switch (status) {
    case "clear": return "Clear";
    case "hit": return "Hit";
    case "uncertain": return "Review";
    case "error": return "Error";
    case "pending": return "Pending";
  }
}

// Rate-limited / blocked errors are written by the engine with a `[RATE_LIMITED]`
// prefix in the `details` field (see RateLimitError + formatErrorDetail in
// screening-engine.ts). The UI uses this to render a yellow "Source temporarily
// unavailable" badge instead of the generic red error — surfaces an honest
// answer to the buyer-facing question "what happens if your IP gets blocked".
export function isRateLimited(check: { status: CheckStatus; details: string | null }): boolean {
  return check.status === "error" && !!check.details?.startsWith("[RATE_LIMITED]");
}

export interface ScreeningCheck {
  id: string;
  screening_id: string;
  database_name: string;
  category: string;
  search_term: string;
  status: CheckStatus;
  screenshot_path: string | null;
  source_url: string | null;
  details: string | null;
  checked_at: string | null;
}

export type CheckCategory =
  | "sanctions"
  | "pep"
  | "adverse_media"
  | "company_registry"
  | "tax_risk";
