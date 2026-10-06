import { reactive } from "vue";
import { request } from "./api-client";
import { hasSession, onSessionInvalidated, sessionGeneration } from "./session";

export type Invitation = { id: string; network: string; expires_at: number; server: string; repository?: string; command: string };
export type InvitationStatus = { state: "pending" | "closed" | "registered"; node_id?: string; expires_at?: number };
export const registration = reactive<{ invitation?: Invitation; completed?: { id: string; node_id: string; network: string } }>({});
let creating: Promise<Invitation> | undefined;
function requireCurrentSession(generation: number) {
  if (generation !== sessionGeneration() || !hasSession()) throw new Error("会话已结束，请重新登录。");
}
export function activeInvitation(network: string, now = Date.now()) {
  const invite = registration.invitation;
  return invite?.network === network && invite.expires_at > now ? invite : undefined;
}
export function createInvitation(_network?: string, signal?: AbortSignal): Promise<Invitation> {
  const generation = sessionGeneration();
  requireCurrentSession(generation);
  const previous = creating;
  const task = (async () => {
    // A late response from a closed dialog must finish before its replacement
    // is issued, otherwise its server-side creation could replace the new one.
    if (previous) await previous.catch(() => {});
    requireCurrentSession(generation);
    signal?.throwIfAborted();
    const data = await request<Omit<Invitation, "command">>("/invitations", "POST");
    const cancel = () => {
      clearInvitation(data.id);
      void revokeInvitation(data.id).catch(() => {});
    };
    // Do not abort the creation HTTP request: we need its id to revoke an
    // invitation created while the dialog was being closed.
    if (signal?.aborted) { cancel(); signal.throwIfAborted(); }
    requireCurrentSession(generation);
    signal?.addEventListener("abort", cancel, { once: true });
    const localHTTP = location.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(location.hostname);
    const invitation = { ...data, command: 'spider-watch configure --server "' + data.server + '" --join ' + data.network + (localHTTP ? " --allow-local-http" : "") };
    registration.completed = undefined; registration.invitation = invitation;
    return invitation;
  })().finally(() => { if (creating === task) creating = undefined; });
  creating = task;
  return task;
}
export async function checkInvitation(id: string, signal?: AbortSignal): Promise<InvitationStatus> {
  const generation = sessionGeneration();
  const result = await request<InvitationStatus>("/invitations/" + encodeURIComponent(id), "GET", undefined, { signal });
  requireCurrentSession(generation);
  const current = registration.invitation;
  if (current?.id === id) {
    if (result.state === "registered" && result.node_id) {
      registration.completed = { id, node_id: result.node_id, network: current.network };
      registration.invitation = undefined;
    } else if (result.state === "closed") registration.invitation = undefined;
  }
  return result;
}
export function clearInvitation(id?: string) {
  if (!id || registration.invitation?.id === id) registration.invitation = undefined;
}
export async function revokeInvitation(id: string) {
  const generation = sessionGeneration();
  clearInvitation(id);
  await request("/invitations/" + encodeURIComponent(id), "DELETE", undefined, { keepalive: true });
  requireCurrentSession(generation);
  if (registration.invitation?.id === id) clearInvitation();
}
onSessionInvalidated(() => { creating = undefined; registration.invitation = undefined; registration.completed = undefined; });
