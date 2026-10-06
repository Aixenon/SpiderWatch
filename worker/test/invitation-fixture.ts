import { env } from "cloudflare:workers";
import worker from "../src/index";

// Older telemetry/UI tests keep their legacy device fixtures but must enroll
// through the same explicit, expiring invitation requirement as real agents.
export async function invitationHeaders(): Promise<Record<string,string>> {
  const response = await worker.fetch(new Request("http://127.0.0.1/api/invitations", {
    method:"POST", headers:{Origin:"http://127.0.0.1"},
  }),env);
  if (!response.ok) throw new Error("test invitation creation failed: " + response.status);
  const data = await response.json<{server:string}>();
  return {"X-Monitor-Invitation":new URLSearchParams(new URL(data.server).hash.slice(1)).get("invite")!};
}
