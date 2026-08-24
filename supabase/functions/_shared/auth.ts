/**
 * Shared HTTP helpers for the Edge Functions.
 *
 * Both functions are invoked by Supabase Cron over pg_net with a shared secret. That secret is the only thing
 * standing between an anonymous caller and the monitor's signing key, so the comparison is constant-time and
 * a weak or absent secret fails closed rather than open.
 */

/**
 * Compares two strings without leaking their common prefix length through timing.
 * Length is compared separately because it is not secret: an attacker learns nothing useful from it.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

/** Minimum acceptable CRON_SECRET length. Short secrets are brute-forceable over a public HTTP endpoint. */
export const MIN_CRON_SECRET_LENGTH = 24;

export type AuthResult = { ok: true } | { ok: false; reason: "MISCONFIGURED" | "UNAUTHORIZED" };

/**
 * Authorises a cron invocation against an explicitly supplied secret. Distinguishes "the server has no usable
 * secret" (a deployment fault the operator must see) from "the caller supplied the wrong secret" — but both
 * refuse the request. Pure, so it is testable without granting the test runner environment access.
 */
export function checkCronAuth(req: Request, expected: string | undefined): AuthResult {
  if (!expected || expected.length < MIN_CRON_SECRET_LENGTH) return { ok: false, reason: "MISCONFIGURED" };
  const supplied = req.headers.get("x-uptimesure-cron-secret");
  if (!supplied) return { ok: false, reason: "UNAUTHORIZED" };
  return timingSafeEqual(supplied, expected) ? { ok: true } : { ok: false, reason: "UNAUTHORIZED" };
}

/** Authorises a cron invocation against the deployed CRON_SECRET. Use this from request handlers. */
export function authorizeCron(req: Request): AuthResult {
  return checkCronAuth(req, Deno.env.get("CRON_SECRET"));
}

/** Convenience wrapper for call sites that only need a boolean. */
export function authorizedCron(req: Request): boolean {
  return authorizeCron(req).ok;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** The 401/500 response for a rejected cron call. Never echoes the supplied or expected secret. */
export function cronRejection(result: Extract<AuthResult, { ok: false }>): Response {
  return result.reason === "MISCONFIGURED"
    ? json({ error: "CRON_SECRET is not configured with a sufficiently long value" }, 500)
    : json({ error: "unauthorized" }, 401);
}
