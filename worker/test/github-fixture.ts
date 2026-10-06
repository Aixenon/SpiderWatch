import { env } from "cloudflare:workers";
import { SignJWT } from "jose";

export const origin = "https://monitor.example.test";
export const sessionName = "__Host-spiderwatch-session", flowName = "__Host-spiderwatch-oauth";
export function githubSettings(): Env {
  return { ...env, LOCAL_DEV: "false", GITHUB_CLIENT_ID: "test-client-id", GITHUB_CLIENT_SECRET: "test-client-secret-for-oauth", SESSION_SECRET: "a".repeat(64), ADMIN_GITHUB_IDS: "12345",
    LOGIN_LIMITER: { limit: async () => ({ success: true }) } };
}
export async function sessionToken(config = githubSettings(), changes: Record<string, unknown> = {}, typ = "spiderwatch-session", algorithm = "HS256") {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: "12345", login: "owner", iss: "spiderwatch", aud: origin + "|" + config.GITHUB_CLIENT_ID, iat: now, exp: now + 3600, ...changes })
    .setProtectedHeader({ alg: algorithm, typ }).sign(new TextEncoder().encode(config.SESSION_SECRET));
}
export const sessionHeaders = async (config = githubSettings()) => ({ Cookie: sessionName + "=" + await sessionToken(config) });
