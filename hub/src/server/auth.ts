import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "skanvil_hub_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

export function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match?.[1]?.trim() || undefined;
}

export function verifyApiKey(authHeader: string | undefined, apiKeys: readonly string[]): boolean {
  if (apiKeys.length === 0) return true;
  const token = extractBearerToken(authHeader);
  if (!token) return false;
  let matched = false;
  for (const key of apiKeys) {
    if (constantTimeEqual(token, key)) matched = true;
  }
  return matched;
}

function signExpiry(expSec: number, adminToken: string): string {
  return createHmac("sha256", adminToken).update(`skanvil-hub-v1:${expSec}`).digest("hex");
}

export function createSessionCookieValue(adminToken: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const exp = nowSec + SESSION_TTL_SECONDS;
  const sig = signExpiry(exp, adminToken);
  return `${exp}.${sig}`;
}

export function verifySessionCookieValue(
  value: string | undefined,
  adminToken: string,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  if (!Number.isInteger(exp) || exp <= nowSec) return false;
  const expected = signExpiry(exp, adminToken);
  return constantTimeEqual(parts[1], expected);
}

export function parseCookieHeader(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const rawPart of cookieHeader.split(";")) {
    const eqIndex = rawPart.indexOf("=");
    if (eqIndex <= 0) continue;
    const key = rawPart.slice(0, eqIndex).trim();
    if (key === name) {
      return decodeURIComponent(rawPart.slice(eqIndex + 1).trim());
    }
  }
  return undefined;
}

export function isAdminAuthorized(
  cookieHeader: string | undefined,
  authHeader: string | undefined,
  adminToken: string | undefined,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!adminToken) return true;
  const bearer = extractBearerToken(authHeader);
  if (bearer && constantTimeEqual(bearer, adminToken)) return true;
  const cookieValue = parseCookieHeader(cookieHeader, SESSION_COOKIE_NAME);
  return verifySessionCookieValue(cookieValue, adminToken, nowSec);
}

export function buildSessionSetCookie(value: string, secure: boolean, clear = false): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${clear ? "" : encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (secure) parts.push("Secure");
  parts.push(clear ? "Max-Age=0" : `Max-Age=${SESSION_TTL_SECONDS}`);
  return parts.join("; ");
}
