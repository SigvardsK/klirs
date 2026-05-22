import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { runScreening, calculateTotalChecks } from "@/lib/screening-engine";
import { checkLimit, recordRun, hashIp, clientIpFrom, RATE_LIMIT_CONFIG } from "@/lib/rate-limit";
import type { Person } from "@/lib/types";

/**
 * POST /api/demo/run
 *
 * Public endpoint — kicks off an unauthenticated trial screening. The visitor
 * supplies a name; we create a `screenings` row with `is_demo=true` and
 * `created_by=null`, fire the engine async (same fire-and-forget pattern as
 * the authed flow at /api/screenings/[id]/run), and return the new screening
 * id so the client can poll /api/demo/[id]/status until completion.
 *
 * Defenses (in order; first failure short-circuits with explicit JSON):
 *   1. Body validation — non-empty name, ≤120 chars.
 *   2. Cloudflare Turnstile (if configured via TURNSTILE_SECRET_KEY env;
 *      otherwise skipped with a warn — env-driven so we can ship before
 *      provisioning Turnstile on the zone).
 *   3. IP-hashed sliding 5/24h rate-limit. Fail-closed on missing pepper / DB
 *      error (LR-WS-2026-029 default).
 *
 * Composes with LR-WS-2026-038: the /demo trial flow inherits the engine's
 * stuck-state risk. The /api/demo/[id]/status synthesizes a `stalled` status
 * after 5 min of no activity (same as the authed status endpoint), so a
 * crashed background runner surfaces as recoverable, not silent.
 */

const MAX_NAME_LENGTH = 120;

// First-party opaque visitor cookie for anonymized funnel telemetry. Holds a
// uuid v4 minted server-side — NOT PII, no IP, no name. Joined to
// profiles.anon_id at signup to compute search->signup conversion.
const ANON_COOKIE = "klirs_anon";
const ANON_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

interface RunRequest {
  name?: unknown;
  entityType?: unknown;
  turnstileToken?: unknown;
  locale?: unknown;
}

/**
 * Read the klirs_anon cookie from the raw request header (this route uses the
 * Request/NextResponse API, not next/headers cookies()). Returns null if absent.
 */
function readAnonCookie(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === ANON_COOKIE) {
      const val = part.slice(eq + 1).trim();
      return val || null;
    }
  }
  return null;
}

/**
 * Best-effort coarse locale ('en' | 'lv' | null). Resolution order:
 *   1. explicit `locale` in the request body (frontend may pass it),
 *   2. referer path segment (/lv vs /en),
 *   3. Accept-Language header leading tag.
 * Stored for cohort breakdown only — null is acceptable (LR-WS-2026-029:
 * we record what we observed, never invent a default).
 */
function deriveLocale(request: Request, body: RunRequest): string | null {
  const fromBody =
    typeof body.locale === "string" ? body.locale.trim().toLowerCase() : "";
  if (fromBody === "en" || fromBody === "lv") return fromBody;

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const path = new URL(referer).pathname;
      if (/^\/lv(\/|$)/.test(path)) return "lv";
      if (/^\/en(\/|$)/.test(path)) return "en";
    } catch {
      // ignore malformed referer
    }
  }

  const acceptLang = request.headers.get("accept-language");
  if (acceptLang) {
    const tag = acceptLang.split(",")[0]?.trim().slice(0, 2).toLowerCase();
    if (tag === "lv") return "lv";
    if (tag === "en") return "en";
  }

  return null;
}

function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
  );
}

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn(
      "[demo-run] TURNSTILE_SECRET_KEY not set — skipping Turnstile verification. " +
        "Provision a Turnstile site on the klirs.eu zone and set this secret to enable."
    );
    return true;
  }
  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret, response: token, remoteip: ip }),
      }
    );
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    console.error("[demo-run] Turnstile verify failed:", err);
    return false;
  }
}

export async function POST(request: Request) {
  let body: RunRequest;
  try {
    body = (await request.json()) as RunRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (name.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: `Name too long (max ${MAX_NAME_LENGTH} chars)` },
      { status: 400 }
    );
  }

  const entityType: "company" | "individual" =
    body.entityType === "company" ? "company" : "individual";

  const ip = clientIpFrom(request.headers);

  // Turnstile (optional gate — env-driven)
  const turnstileToken =
    typeof body.turnstileToken === "string" ? body.turnstileToken : "";
  if (process.env.TURNSTILE_SECRET_KEY && !turnstileToken) {
    return NextResponse.json(
      { error: "Bot verification required" },
      { status: 400 }
    );
  }
  if (turnstileToken) {
    const ok = await verifyTurnstile(turnstileToken, ip);
    if (!ok) {
      return NextResponse.json(
        { error: "Bot verification failed" },
        { status: 403 }
      );
    }
  }

  // Rate-limit (fail-closed on missing pepper / DB error)
  let ipHash: string;
  try {
    ipHash = hashIp(ip);
  } catch (err) {
    console.error("[demo-run]", err);
    return NextResponse.json(
      { error: "Service misconfigured" },
      { status: 503 }
    );
  }

  const limit = await checkLimit(ipHash);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        error: "Daily trial limit reached",
        retryAfterSeconds: limit.retryAfterSeconds,
        runsPerDay: RATE_LIMIT_CONFIG.runsPerWindow,
      },
      { status: 429 }
    );
  }

  // Create the ephemeral screening row. `created_by=null` + `is_demo=true` is
  // the contract that lets /api/demo/[id]/* read it without auth, and that the
  // GC sweep uses to drop trial rows after 24h.
  const supabase = getAdminClient();
  const persons: Person[] =
    entityType === "individual" ? [{ name, role: "", aliases: [] }] : [];
  const { data: screening, error: insertErr } = await supabase
    .from("screenings")
    .insert({
      created_by: null,
      entity_name: name,
      entity_type: entityType,
      jurisdiction: "LV",
      registration_number: null,
      persons,
      status: "pending",
      is_demo: true,
    })
    .select("id")
    .single();

  if (insertErr || !screening) {
    console.error("[demo-run] Failed to insert demo screening:", insertErr);
    return NextResponse.json({ error: "Failed to start trial" }, { status: 500 });
  }

  // Record the run BEFORE firing engine — if engine crashes, the rate-limit
  // ledger still reflects intent (so spamming retries doesn't bypass the cap).
  await recordRun({
    ipHash,
    screeningId: screening.id,
    subjectName: name,
  });

  const job = {
    screeningId: screening.id,
    entityName: name,
    entityType,
    jurisdiction: "LV",
    registrationNumber: null,
    persons:
      entityType === "individual" && persons.every(p => !p.name?.trim())
        ? [{ name, role: "", aliases: [] }]
        : persons,
  };

  // Fire-and-forget — same pattern as authed runs.
  runScreening(job).catch(err => {
    console.error("[demo-run] Background screening failed:", err);
  });

  // Anonymized, GC-immune funnel telemetry. Resolve / mint the first-party
  // visitor cookie, record ONE search event, and set the cookie on the SAME
  // response we return. Telemetry failure must NEVER break the screening, so
  // every step is best-effort (try/catch + console.error only).
  let anonId = readAnonCookie(request);
  const isNewAnon = !anonId;
  if (!anonId) {
    anonId = crypto.randomUUID();
  }
  const locale = deriveLocale(request, body);

  try {
    const { error: telemetryErr } = await supabase
      .from("demo_search_events")
      .insert({
        anon_id: anonId,
        entity_type: entityType,
        locale,
      });
    if (telemetryErr) {
      console.error("[demo-run] telemetry insert failed:", telemetryErr.message);
    }
  } catch (err) {
    console.error("[demo-run] telemetry insert threw:", err);
  }

  const response = NextResponse.json(
    {
      screeningId: screening.id,
      totalChecks: calculateTotalChecks(job),
      remaining: limit.remaining - 1,
    },
    { status: 202 }
  );

  // Persist the anon cookie. httpOnly (server-only join key — never read in JS),
  // secure, sameSite=lax, long-lived. Set even when it already existed to
  // refresh maxAge for returning visitors.
  response.cookies.set(ANON_COOKIE, anonId, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: ANON_COOKIE_MAX_AGE,
    path: "/",
  });
  if (isNewAnon) {
    console.log(
      JSON.stringify({ event: "demo.run.anon_minted", anonId, locale, entityType })
    );
  }

  return response;
}
