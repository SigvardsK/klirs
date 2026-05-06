/**
 * Smoke test: auth contract regression tripwire (LR-WS-2026-036 — class-level fix coverage).
 *
 * The auth path's RLS contract has three load-bearing invariants. Each one,
 * if absent, recreates a documented prior bug:
 *
 * 1. profiles SELECT, UPDATE, *and* INSERT policies all exist. Postgres
 *    evaluates INSERT WITH CHECK on every `INSERT ... ON CONFLICT DO UPDATE`,
 *    regardless of whether the conflict path runs. Missing the INSERT policy
 *    → 42501 on every OAuth + magic-link callback (regressed once already,
 *    fix shipped in 20260506_profiles_insert_policy.sql).
 *
 * 2. The handle_new_user trigger exists on auth.users. It auto-creates a
 *    profile row on first signup; without it, every new user hits the
 *    user-JWT INSERT path which is intentionally narrow. Removal would
 *    silently work for OAuth (admin client) but break magic-link signup
 *    edge cases.
 *
 * 3. The gc_auth_pkce_state trigger exists. Without it, abandoned OAuth
 *    rows accumulate (LR-WS-2026-038 — fire-and-forget background work
 *    must ship with a stuck-state probe).
 *
 * Each assertion fails with a specific message naming the prior bug so the
 * test name itself documents what regressed if it fires.
 *
 * Usage:
 *   npm run smoke:auth
 *   # Requires `supabase` CLI installed + `supabase link` to the project.
 *
 * Exit 0 = all invariants intact. Exit 1 = at least one regression.
 * Exit 2 = infra error (CLI missing, link broken, query failed).
 */

import { execSync } from "node:child_process";

interface SqlRow {
  [key: string]: string | number | boolean | null;
}

function runSql(query: string): SqlRow[] {
  let raw: string;
  try {
    raw = execSync(`echo ${JSON.stringify(query)} | supabase db query --linked`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[infra] supabase db query failed:", message);
    process.exit(2);
  }

  // Output is JSON wrapped in MIME boundary markers + warning text. Find the
  // JSON object — `supabase db query` emits a single object with `rows`.
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < 0) {
    console.error("[infra] supabase db query produced no JSON. Raw:\n" + raw);
    process.exit(2);
  }
  const jsonText = raw.slice(jsonStart, jsonEnd + 1);

  let parsed: { rows?: SqlRow[] };
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    console.error("[infra] supabase db query JSON parse failed. Raw:\n" + raw);
    process.exit(2);
  }
  return parsed.rows ?? [];
}

interface Assertion {
  label: string;
  query: string;
  failIf: (rows: SqlRow[]) => string | null; // returns failure reason, or null if pass
}

const assertions: Assertion[] = [
  {
    label: "profiles RLS — SELECT, UPDATE, INSERT policies all present",
    query:
      "select cmd::text as cmd, policyname::text as policyname from pg_policies where tablename = 'profiles' and schemaname = 'public' order by cmd;",
    failIf: (rows) => {
      const cmds = new Set(rows.map((r) => String(r.cmd)));
      const required = ["SELECT", "UPDATE", "INSERT"];
      const missing = required.filter((c) => !cmds.has(c));
      if (missing.length > 0) {
        return `profiles missing RLS policies for: ${missing.join(", ")}. Recreates the day-one upsert-fails-with-42501 regression. Fix: re-run supabase/migrations/20260506_profiles_insert_policy.sql.`;
      }
      return null;
    },
  },
  {
    label: "profiles INSERT policy uses auth.uid() = id (right shape)",
    query:
      "select with_check::text as with_check from pg_policies where tablename = 'profiles' and schemaname = 'public' and cmd = 'INSERT';",
    failIf: (rows) => {
      if (rows.length === 0) return "no INSERT policy found (covered by previous assertion, but flagging here too)";
      const expr = String(rows[0].with_check ?? "");
      // Normalise whitespace + casing for the structural check; allow either
      // (auth.uid() = id) or (id = auth.uid()).
      const normalised = expr.replace(/\s+/g, "").toLowerCase();
      const wantsA = normalised.includes("auth.uid()=id");
      const wantsB = normalised.includes("id=auth.uid()");
      if (!wantsA && !wantsB) {
        return `INSERT policy WITH CHECK is "${expr}" — expected to constrain on auth.uid() = id. Wrong shape would let any authenticated user insert anyone's profile.`;
      }
      return null;
    },
  },
  {
    label: "handle_new_user trigger exists on auth.users",
    query:
      "select tgname::text as tgname from pg_trigger where tgname = 'on_auth_user_created' and not tgisinternal;",
    failIf: (rows) => {
      if (rows.length === 0) {
        return "handle_new_user trigger missing. New OAuth/magic-link users would have no profile row — admin-client upsert would still create one (post-fix), but the trigger is the canonical source of profile rows.";
      }
      return null;
    },
  },
  {
    label: "auth_pkce_state GC trigger exists (LR-WS-2026-038 stuck-state probe)",
    query:
      "select tgname::text as tgname from pg_trigger where tgname = 'gc_auth_pkce_state_on_insert' and not tgisinternal;",
    failIf: (rows) => {
      if (rows.length === 0) {
        return "gc_auth_pkce_state_on_insert trigger missing. Abandoned OAuth rows in auth_pkce_state would accumulate. Re-run supabase/migrations/20260506_auth_pkce_state_gc.sql.";
      }
      return null;
    },
  },
];

async function main() {
  console.log("Auth contract smoke test\n");

  let failures = 0;
  for (const a of assertions) {
    const rows = runSql(a.query);
    const reason = a.failIf(rows);
    if (reason === null) {
      console.log(`  PASS  ${a.label}`);
    } else {
      console.log(`  FAIL  ${a.label}`);
      console.log(`        ${reason}`);
      failures += 1;
    }
  }

  console.log("");
  if (failures === 0) {
    console.log("All assertions passed. Auth contract intact.");
    process.exit(0);
  }
  console.log(`${failures} assertion(s) failed. Auth contract regressed — see messages above.`);
  process.exit(1);
}

main();
