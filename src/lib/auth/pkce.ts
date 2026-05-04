import { randomBytes, createHash } from "node:crypto";

/**
 * Server-managed PKCE state for Brave / privacy-aggressive browser compatibility.
 *
 * Why this exists: the standard @supabase/ssr PKCE flow stores the code verifier
 * in a cookie set on a response that immediately redirects to a different origin
 * (klirs.eu → supabase.co). Brave Shields classify this pattern as bounce-tracking
 * and silently drop the cookie, breaking auth for ~all Brave users in fresh
 * sessions. Firefox-strict and Safari-ITP can hit similar issues.
 *
 * Fix: generate the verifier here, store it in `auth_pkce_state` (Postgres) keyed
 * by an opaque state token, and pass that state through the OAuth URL. Supabase
 * forwards the state back on the callback, where we look up the verifier and
 * complete the exchange manually. No cookie is set on the cross-origin redirect,
 * so Brave Shields has nothing to flag.
 *
 * Verifier length: 32 bytes random, base64url-encoded → ~43 chars. Within RFC 7636
 * recommended range (43–128 chars). Challenge: SHA-256 of the verifier, base64url.
 */

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(
    createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

export function generateState(): string {
  return base64UrlEncode(randomBytes(24));
}
