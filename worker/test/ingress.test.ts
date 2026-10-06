import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
afterEach(() => { vi.restoreAllMocks(); });
it("rejects malformed bootstrap credentials and oversize declared bodies without waking a DO", async () => {
  const monitor = vi.spyOn(env.MONITOR, "getByName").mockImplementation(() => { throw new Error("invalid ingress reached DO"); });
  const invalidHeaders: Record<string, string>[] = [{}, { "X-Monitor-Node-ID": "a".repeat(32), Authorization: "Bearer short" }, { "X-Monitor-Node-ID": "../../admin", Authorization: "Bearer " + "b".repeat(64) }];
  for (const headers of invalidHeaders) {
    const response = await worker.fetch(new Request("http://127.0.0.1/bootstrap/status", { method: "POST", headers }), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "device_auth_required" });
  }
  for (const path of ["/bootstrap/status", "/bootstrap/enroll"]) {
    const response = await worker.fetch(new Request("http://127.0.0.1" + path, { method: "POST", headers: { "Content-Length": "32769" } }), env);
    expect(response.status).toBe(413);
  }
  expect(monitor).not.toHaveBeenCalled();
});
it("applies the same cheap credential check to monitoring GETs", async () => {
  const monitor = vi.spyOn(env.MONITOR, "getByName").mockImplementation(() => { throw new Error("invalid ingress reached DO"); });
  for (const path of ["/v1/live", "/v1/nodes/" + "a".repeat(32) + "/status"]) {
    const response = await worker.fetch(new Request("http://127.0.0.1" + path), env);
    expect(response.status).toBe(401);
  }
  expect(monitor).not.toHaveBeenCalled();
});
