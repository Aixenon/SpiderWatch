import { hash } from "./model";

export const INVITATION_MS = 5 * 60_000;
export const AUTH_WINDOW_MS = 60_000;
const encoder = new TextEncoder();
export function randomHex(bytes = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
function decode64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), ch => ch.charCodeAt(0));
}
function encode64(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)));
}
async function invitationKey(env: Env): Promise<CryptoKey> {
  const secret = env.INVITATION_SECRET || (env.LOCAL_DEV === "true" ? "local-development-invitations-only" : "");
  if (secret.length < 32) throw new Error("invitation_not_configured");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function issueInvitation(env: Env, id: string, expires: number): Promise<string> {
  const payload = `${id}.${expires}`;
  const signature = await crypto.subtle.sign("HMAC", await invitationKey(env), encoder.encode(`${env.MONITOR_GROUP}\n${payload}`));
  return `${payload}.${encode64(signature)}`;
}
export async function verifyInvitation(env: Env, token: string): Promise<{ id: string; expires: number } | null> {
  const match = /^([a-f0-9]{32})\.([0-9]{13})\.([A-Za-z0-9+/]{43}=)$/.exec(token);
  if (!match) return null;
  const expires = Number(match[2]);
  if (expires <= Date.now() || expires > Date.now() + INVITATION_MS + 5_000) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await invitationKey(env), decode64(match[3]), encoder.encode(`${env.MONITOR_GROUP}\n${match[1]}.${match[2]}`));
    return valid ? { id: match[1], expires } : null;
  } catch { return null; }
}
// Accept only the SSH wire representation of an Ed25519 public key. Workers
// never receives a private key or needs an SSH server/SSH protocol session.
export function sshPublicBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(value)) return null;
  try {
    const bytes = decode64(value.slice(12));
    if (bytes.length !== 51 || new DataView(bytes.buffer).getUint32(0) !== 11
      || new TextDecoder().decode(bytes.slice(4, 15)) !== "ssh-ed25519"
      || new DataView(bytes.buffer).getUint32(15) !== 32) return null;
    return bytes.slice(19);
  } catch { return null; }
}
export function signedHeadersValid(request: Request): boolean {
  return /^[a-f0-9]{32}$/.test(request.headers.get("X-Monitor-Node-ID") || "")
    && /^[0-9]{13}$/.test(request.headers.get("X-Monitor-Time") || "")
    && Math.abs(Date.now() - Number(request.headers.get("X-Monitor-Time"))) <= AUTH_WINDOW_MS
    && /^[a-f0-9]{32}$/.test(request.headers.get("X-Monitor-Nonce") || "")
    && /^[A-Za-z0-9+/]{86}==$/.test(request.headers.get("X-Monitor-Signature") || "");
}
export async function signaturePayload(request: Request): Promise<string> {
  let body = "";
  if (request.body) {
    const reader = request.clone().body!.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length;
        if (size > 32768) { await reader.cancel(); throw new Error("body_too_large"); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  }
  const url = new URL(request.url);
  return ["cf-monitor-auth-v1", request.method, url.origin, url.pathname + url.search,
    request.headers.get("X-Monitor-Node-ID"), request.headers.get("X-Monitor-Time"),
    request.headers.get("X-Monitor-Nonce"), await hash(body)].join("\n");
}
export async function verifyDeviceSignature(request: Request, publicKey: string): Promise<boolean> {
  if (!signedHeadersValid(request)) return false;
  const bytes = sshPublicBytes(publicKey); if (!bytes) return false;
  try {
    const key = await crypto.subtle.importKey("raw", bytes, "Ed25519", false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, decode64(request.headers.get("X-Monitor-Signature")!), encoder.encode(await signaturePayload(request)));
  } catch { return false; }
}
