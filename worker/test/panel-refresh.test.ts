import {expect,it,vi} from "vitest";
import {createPanelRefresh} from "../public/panel-refresh.js";

function delayedReads() {
  const finish:((loaded:boolean)=>void)[]=[];
  const read=vi.fn(()=>new Promise<boolean>(resolve=>finish.push(resolve)));
  return {read,finish};
}

it("shares startup, route and socket-open reads instead of scheduling duplicate snapshots",async()=>{
  const {read,finish}=delayedReads();
  let now=0;
  const refresh=createPanelRefresh(read,{now:()=>now});
  const first=refresh.load();
  expect(refresh.load()).toBe(first);
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  expect(refresh.load()).toBe(first);
  finish[0](true);await first;
  // A socket-open notification arriving just after the route read can reuse it.
  now=500;expect(await refresh.load()).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
  now=120000;const periodic=refresh.load();await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  finish[1](true);await periodic;
});

it("coalesces mutation notifications into a read that begins after the changes",async()=>{
  const {read,finish}=delayedReads(),refresh=createPanelRefresh(read);
  const first=refresh.load();
  // Events before the queued read starts are already covered by that snapshot.
  expect(refresh.load(true)).toBe(first);
  await Promise.resolve();
  for(let i=0;i<20;i++)expect(refresh.load(true)).toBe(first);
  finish[0](true);await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  // Ordinary lifecycle checks during the required follow-up add no third read.
  expect(refresh.load()).toBe(first);
  finish[1](true);expect(await first).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
});

it("always reads for an explicit refresh or a completed management change",async()=>{
  const read=vi.fn().mockResolvedValue(true),refresh=createPanelRefresh(read,{now:()=>0});
  expect(await refresh.load()).toBe(true);
  expect(await refresh.load()).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);
  expect(await refresh.load(true)).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
});

it("pauses hidden reads and reconciles immediately on returning even within the reuse window",async()=>{
  let visible=true;
  const read=vi.fn().mockResolvedValue(true),refresh=createPanelRefresh(read,{enabled:()=>visible,now:()=>0});
  await refresh.load();
  visible=false;refresh.invalidate();
  expect(await refresh.load()).toBe(false);
  expect(await refresh.load(true)).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  visible=true;await refresh.load();
  expect(read).toHaveBeenCalledTimes(2);
});

it("does not reuse a snapshot started before the panel was hidden and restored",async()=>{
  let visible=true;
  const {read,finish}=delayedReads(),refresh=createPanelRefresh(read,{enabled:()=>visible});
  const first=refresh.load();await Promise.resolve();
  visible=false;refresh.invalidate();
  visible=true;expect(refresh.load()).toBe(first);
  finish[0](true);await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  finish[1](true);await first;
});

it("drops queued background reads when hidden or Access permission expires",async()=>{
  let allowed=true;
  const {read,finish}=delayedReads(),refresh=createPanelRefresh(read,{enabled:()=>allowed});
  const first=refresh.load();await Promise.resolve();refresh.load(true);
  allowed=false;refresh.invalidate();finish[0](false);
  expect(await first).toBe(false);
  expect(await refresh.load(true)).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
  allowed=true;const restored=refresh.load();await Promise.resolve();
  finish[1](true);await restored;
  expect(read).toHaveBeenCalledTimes(2);
});

it("does not treat failed or rejected reads as reusable results",async()=>{
  const read=vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true);
  const refresh=createPanelRefresh(read,{now:()=>0});
  expect(await refresh.load()).toBe(false);
  await expect(refresh.load()).rejects.toThrow("offline");
  expect(await refresh.load()).toBe(true);
  expect(read).toHaveBeenCalledTimes(3);
});

it("does not reuse an older success when a forced refresh rejects",async()=>{
  const read=vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true);
  const refresh=createPanelRefresh(read,{now:()=>0});
  await refresh.load();
  await expect(refresh.load(true)).rejects.toThrow("offline");
  expect(await refresh.load()).toBe(true);
  expect(read).toHaveBeenCalledTimes(3);
});
