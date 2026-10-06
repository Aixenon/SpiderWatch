import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { request } from "../src/api-client";
import { activeInvitation, checkInvitation, createInvitation, registration } from "../src/invitations";
import { lockSession } from "../src/session";

vi.mock("../src/api-client", () => ({ request: vi.fn() }));
vi.mock("../src/session", () => {
  let generation = 0;
  const listeners = new Set<() => void>();
  return {
    hasSession: () => true,
    sessionGeneration: () => generation,
    onSessionInvalidated: (listener: () => void) => listeners.add(listener),
    lockSession: () => { generation++; for (const listener of listeners) listener(); },
  };
});
const mocked = vi.mocked(request);
const invitation = (id: string) => ({ id, network: "network", server: "https://monitor.example.com/#invite=" + id, expires_at: Date.now() + 300000 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  lockSession(); mocked.mockReset();
  vi.stubGlobal("location", { protocol: "https:", hostname: "monitor.example.com" });
});
afterEach(() => vi.unstubAllGlobals());

it("always requests a new invitation instead of reusing the current unexpired command", async () => {
  mocked.mockResolvedValueOnce(invitation("first")).mockResolvedValueOnce(invitation("second"));
  const first = await createInvitation("network"), second = await createInvitation("network");
  expect(first.id).not.toBe(second.id);
  expect(mocked.mock.calls).toEqual([["/invitations", "POST"], ["/invitations", "POST"]]);
  expect(activeInvitation("network")?.id).toBe("second");
});

it("closing immediately clears the command and sends a keepalive revocation", async () => {
  const closing = deferred<{ ok: true }>(), lifecycle = new AbortController();
  mocked.mockResolvedValueOnce(invitation("old")).mockReturnValueOnce(closing.promise);
  await createInvitation("network", lifecycle.signal);
  lifecycle.abort();
  expect(activeInvitation("network")).toBeUndefined();
  expect(mocked).toHaveBeenLastCalledWith("/invitations/old", "DELETE", undefined, { keepalive: true });
  closing.resolve({ ok: true });
});

it("revokes a late creation response before opening a fresh attempt", async () => {
  const firstResponse = deferred<ReturnType<typeof invitation>>(), firstLife = new AbortController();
  mocked.mockImplementation(async (path, method) => {
    if (method === "DELETE") return { ok: true };
    if (path === "/invitations" && mocked.mock.calls.filter(call => call[1] === "POST").length === 1) return firstResponse.promise;
    return invitation("new");
  });
  const first = createInvitation("network", firstLife.signal);
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  firstLife.abort();
  const second = createInvitation("network", new AbortController().signal);
  expect(mocked).toHaveBeenCalledTimes(1);
  firstResponse.resolve(invitation("old"));
  await rejected;
  expect((await second).id).toBe("new");
  expect(mocked.mock.calls.map(call => [call[0], call[1]])).toEqual([
    ["/invitations", "POST"], ["/invitations/old", "DELETE"], ["/invitations", "POST"],
  ]);
  expect(registration.invitation?.id).toBe("new");
});

it("does not send a queued creation when that dialog was already closed", async () => {
  const response = deferred<ReturnType<typeof invitation>>(), queuedLife = new AbortController();
  mocked.mockReturnValueOnce(response.promise);
  const first = createInvitation("network");
  const queued = createInvitation("network", queuedLife.signal);
  const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
  queuedLife.abort(); response.resolve(invitation("first"));
  await first; await rejected;
  expect(mocked).toHaveBeenCalledTimes(1);
});

it("keeps a replacement invitation when an earlier revocation completes late", async () => {
  const closing = deferred<{ ok: true }>(), lifecycle = new AbortController();
  mocked.mockResolvedValueOnce(invitation("old")).mockReturnValueOnce(closing.promise).mockResolvedValueOnce(invitation("new"));
  await createInvitation("network", lifecycle.signal); lifecycle.abort();
  await createInvitation("network"); closing.resolve({ ok: true });
  await Promise.resolve(); await Promise.resolve();
  expect(registration.invitation?.id).toBe("new");
});

it("passes cancellation to checks and keeps successful registrations out of cancellation", async () => {
  const lifecycle = new AbortController();
  mocked.mockResolvedValueOnce(invitation("done")).mockResolvedValueOnce({ state: "registered", node_id: "node" });
  await createInvitation("network", lifecycle.signal);
  expect(await checkInvitation("done", lifecycle.signal)).toEqual({ state: "registered", node_id: "node" });
  expect(mocked).toHaveBeenLastCalledWith("/invitations/done", "GET", undefined, { signal: lifecycle.signal });
  expect(registration.invitation).toBeUndefined();
  expect(registration.completed?.node_id).toBe("node");
  expect(mocked.mock.calls.some(call => call[1] === "DELETE")).toBe(false);
});
