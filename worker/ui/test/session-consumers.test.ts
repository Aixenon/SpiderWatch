import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { request } from "../src/api-client";
import { authenticated, hasSession, lockSession } from "../src/session";
import type { Invitation } from "../src/invitations";

vi.mock("../src/api-client", () => ({ request: vi.fn() }));
vi.mock("../src/session", async () => {
  const { ref } = await import("vue");
  const authenticated = ref(false), listeners = new Set<() => void>();
  let generation = 0;
  return {
    authenticated,
    hasSession: () => authenticated.value,
    sessionGeneration: () => generation,
    onSessionInvalidated: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    lockSession: () => { generation++; authenticated.value = false; for (const listener of listeners) listener(); },
  };
});

const requestMock = vi.mocked(request);
const page = { hidden: true, addEventListener: vi.fn() };
let monitor: typeof import("../src/monitor");
let invitations: typeof import("../src/invitations");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function stateResponse() {
  return { group: "old-network", node_groups: [{ id: "old-group", name: "old private group" }], nodes: [],
    settings: { active_seconds: 10, idle_seconds: 600, version: 20, updated_at: Date.now() } };
}
function invitation(id: string): Invitation {
  return { id, network: "network", expires_at: Date.now() + 300000, server: "https://monitor.example.com/#invite=" + id, command: "join " + id };
}
async function signInAgain() {
  page.hidden = true;
  authenticated.value = true;
  await nextTick();
  page.hidden = false;
}

beforeAll(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", page);
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("location", { protocol: "https:", hostname: "monitor.example.com", host: "monitor.example.com" });
  monitor = await import("../src/monitor");
  invitations = await import("../src/invitations");
});
beforeEach(async () => {
  page.hidden = true; lockSession(); await nextTick();
  requestMock.mockReset();
  await signInAgain();
});
afterEach(async () => {
  page.hidden = true; lockSession(); await nextTick();
  vi.clearAllTimers();
});
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("responses completing across a session boundary", () => {
  it("does not refill state when logout follows API resolution before its consumer runs", async () => {
    const response = deferred<ReturnType<typeof stateResponse>>();
    requestMock.mockReturnValueOnce(response.promise);
    const reading = monitor.loadState(true);
    await Promise.resolve();
    expect(requestMock).toHaveBeenCalledWith("/state?view=live");
    // The API has already succeeded; logout runs before the awaiting consumer resumes.
    response.resolve(stateResponse()); lockSession();
    expect(await reading).toBe(false);
    expect(monitor.state.network).toBe("");
    expect(monitor.state.groups).toEqual([]);
    expect(monitor.runtime.ready).toBe(false);
  });

  it("rejects an old state response even after a new session has started", async () => {
    const response = deferred<ReturnType<typeof stateResponse>>();
    requestMock.mockReturnValueOnce(response.promise);
    const reading = monitor.loadState(true); await Promise.resolve();
    lockSession(); await signInAgain();
    response.resolve(stateResponse());
    expect(await reading).toBe(false);
    expect(hasSession()).toBe(true);
    expect(monitor.state.network).toBe("");
    expect(monitor.runtime.ready).toBe(false);
  });

  it("does not restore saved settings or request another state read after logout", async () => {
    const response = deferred<ReturnType<typeof stateResponse>["settings"]>();
    requestMock.mockReturnValueOnce(response.promise);
    const original = { ...monitor.state.settings };
    const saving = monitor.api.saveSettings(10, 600);
    response.resolve(stateResponse().settings); lockSession();
    await expect(saving).rejects.toThrow("会话已结束");
    expect(monitor.state.settings).toEqual(original);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("does not refresh a new session on behalf of an old mutation", async () => {
    const response = deferred<{ ok: true }>();
    requestMock.mockReturnValueOnce(response.promise);
    const changing = monitor.api.createGroup("old group");
    response.resolve({ ok: true }); lockSession();
    await expect(changing).rejects.toThrow("会话已结束");
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("does not restore an invitation credential after logout", async () => {
    const response = deferred<Invitation>();
    requestMock.mockReturnValueOnce(response.promise);
    const creating = invitations.createInvitation("network");
    response.resolve(invitation("old")); lockSession();
    await expect(creating).rejects.toThrow("会话已结束");
    expect(invitations.registration.invitation).toBeUndefined();
    expect(invitations.registration.completed).toBeUndefined();
  });

  it("lets a new session create an invitation while an older request finishes", async () => {
    const oldResponse = deferred<Invitation>(), newResponse = deferred<Invitation>();
    requestMock.mockReturnValueOnce(oldResponse.promise).mockReturnValueOnce(newResponse.promise);
    const oldCreating = invitations.createInvitation("network");
    lockSession(); await signInAgain();
    const newCreating = invitations.createInvitation("network");
    expect(requestMock).toHaveBeenCalledTimes(2);
    oldResponse.resolve(invitation("old"));
    await expect(oldCreating).rejects.toThrow("会话已结束");
    expect(requestMock).toHaveBeenCalledTimes(2);
    newResponse.resolve(invitation("new")); await newCreating;
    expect(invitations.registration.invitation?.id).toBe("new");
  });

  it("rejects registration checks and revocation results belonging to a closed session", async () => {
    const checkResponse = deferred<{ state: "registered"; node_id: string }>(), revokeResponse = deferred<{ ok: true }>();
    requestMock.mockReturnValueOnce(checkResponse.promise).mockReturnValueOnce(revokeResponse.promise);
    invitations.registration.invitation = invitation("same-id");
    const checking = invitations.checkInvitation("same-id"), revoking = invitations.revokeInvitation("same-id");
    lockSession(); await signInAgain();
    invitations.registration.invitation = invitation("same-id");
    checkResponse.resolve({ state: "registered", node_id: "old-node" }); revokeResponse.resolve({ ok: true });
    await expect(checking).rejects.toThrow("会话已结束");
    await expect(revoking).rejects.toThrow("会话已结束");
    expect(invitations.registration.invitation?.id).toBe("same-id");
    expect(invitations.registration.completed).toBeUndefined();
  });
});
