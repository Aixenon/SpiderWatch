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
export function createInvitation(network?: string): Promise<Invitation> {
  const generation = sessionGeneration();
  requireCurrentSession(generation);
  const current = registration.invitation;
  if (current && (!network || network === current.network) && current.expires_at > Date.now()) return Promise.resolve(current);
  if (creating) return creating;
  const task = (async () => {
    const data = await request<Omit<Invitation, "command">>("/invitations", "POST");
    requireCurrentSession(generation);
    const localHTTP = location.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(location.hostname);
    const invitation = { ...data, command: 'spider-watch configure --server "' + data.server + '" --join ' + data.network + (localHTTP ? " --allow-local-http" : "") };
    registration.completed = undefined; registration.invitation = invitation;
    return invitation;
  })().finally(() => { if (creating === task) creating = undefined; });
  creating = task;
  return task;
}
export async function checkInvitation(id: string): Promise<InvitationStatus> {
  const generation = sessionGeneration();
  const result = await request<InvitationStatus>("/invitations/" + encodeURIComponent(id));
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
export function clearInvitation() { registration.invitation = undefined; }
export async function revokeInvitation(id: string) {
  const generation = sessionGeneration();
  await request("/invitations/" + encodeURIComponent(id), "DELETE");
  requireCurrentSession(generation);
  if (registration.invitation?.id === id) clearInvitation();
}
onSessionInvalidated(() => { creating = undefined; registration.invitation = undefined; registration.completed = undefined; });
