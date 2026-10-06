import {expect,it,vi} from "vitest";
import {createHistoryCache} from "../public/resource-history.js";
import type {ResourcePoint} from "../public/resource-charts.js";
import {chartGeometry,mergeResourceHistory,recordSample} from "../public/resource-charts.js";
const point=(time:number):ResourcePoint=>({time,cpu:10,memory:20,networks:{}});

it("shares concurrent chart loads, expands only on demand, and reuses larger ranges",async()=>{
  let resolve:any;
  const fetcher=vi.fn((_id:string,_range:number)=>new Promise<{points:ResourcePoint[];from:number;to:number}>(r=>{resolve=r;}));
  const cache=createHistoryCache(fetcher);
  const pending=cache.load("one",300);
  expect(cache.load("one",300)).toBe(pending);
  expect(cache.load("one",604800)).toBe(pending);
  resolve({points:[],from:0,to:0});
  await Promise.resolve();
  expect(fetcher.mock.calls.map(c=>c[1])).toEqual([300,604800]);
  resolve({points:[],from:0,to:0});await pending;
  expect(cache.load("one",1800)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("does not retry failures on every live report and discards responses after logout",async()=>{
  const fetcher=vi.fn().mockRejectedValue(new Error("offline"));
  const cache=createHistoryCache(fetcher);
  await cache.load("one",300);
  expect(cache.load("one",300)).toBeNull();
  expect(cache.get("one").error).toContain("读取失败");
  fetcher.mockResolvedValue({points:[{time:1}],to:1});
  await cache.load("one",300,true);
  expect(cache.get("one").error).toBe("");
  let resolve:any;
  fetcher.mockImplementation(()=>new Promise(r=>{resolve=r;}));
  const pending=cache.load("one",604800);cache.clear();
  resolve({points:[{time:2}],to:2});await pending;
  expect([...cache.keys()]).toHaveLength(0);
});

it("bounds cached devices and checkpoints live data at ten-minute intervals without requests",async()=>{
  const fetcher=vi.fn().mockResolvedValue({points:[{time:1000}],to:1000});
  const cache=createHistoryCache(fetcher,2);
  await cache.load("one",300);
  cache.checkpoint("one",point(6000));
  cache.checkpoint("one",point(601000));
  expect(cache.get("one").points.map((p:any)=>p.time)).toEqual([1000,601000]);
  cache.get("two");cache.get("three");
  expect([...cache.keys()]).toEqual(["two","three"]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("refreshes a missing long pause once on demand, without repeatedly retrying live reports",async()=>{
  const fetcher=vi.fn().mockResolvedValue({points:[point(1000)],to:1000});
  const cache=createHistoryCache(fetcher);
  await cache.load("one",604800);
  cache.checkpoint("one",point(3601000));
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(cache.get("one").stale).toBe(true);
  fetcher.mockRejectedValue(new Error("offline"));
  await cache.load("one",300);
  for(let i=1;i<4;i++){cache.checkpoint("one",point(3601000+i*5000));expect(cache.load("one",300)).toBeNull();}
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("preserves reconnection gaps after the dense live buffer rotates and history refreshes",async()=>{
  const start=1700000000000;
  const fetcher=vi.fn().mockResolvedValue({points:[point(start)],to:start});
  const cache=createHistoryCache(fetcher),live=new Map<string,ResourcePoint[]>();
  await cache.load("one",604800);
  const node={node_id:"one",connected:true,last_seen:start,metrics:{time:new Date(start).toISOString(),cpu_percent:20}};
  recordSample(live,node);
  node.last_seen+=600000;recordSample(live,node);
  cache.checkpoint("one",live.get("one")!.at(-1),live.get("one")!.at(-2));
  for(let i=0;i<125;i++){node.last_seen+=5000;recordSample(live,node);cache.checkpoint("one",live.get("one")!.at(-1));}
  const combined=mergeResourceHistory(cache.get("one").points,live.get("one")!);
  expect(chartGeometry(combined.map(p=>({time:p.time,cpu:p.cpu})),["cpu"],100,3600000).series[0].path.match(/M/g)).toHaveLength(2);
  cache.get("one").stale=true;
  fetcher.mockResolvedValue({points:[point(start),point(start+600000)],to:node.last_seen});
  await cache.load("one",604800);
  expect(cache.get("one").points.some(p=>p.time===start+1&&p.cpu===null)).toBe(true);
});

it("follows changed idle intervals locally and respects sparse historical intervals",async()=>{
  const fetcher=vi.fn().mockResolvedValue({points:[{...point(1000),interval_seconds:3600}],to:1000,interval_seconds:3600,resolution_seconds:1});
  const cache=createHistoryCache(fetcher);
  await cache.load("one",86400);
  cache.checkpoint("one",point(3601000));
  expect(cache.get("one").stale).toBe(false);
  expect(cache.get("one").points.map(p=>p.time)).toEqual([1000,3601000]);
  cache.checkpoint("one",point(3616000),undefined,30);
  cache.checkpoint("one",point(3631000),undefined,30);
  expect(cache.get("one").points.map(p=>p.time)).toEqual([1000,3601000,3631000]);
  expect(cache.get("one").points.at(-1)?.interval_seconds).toBe(30);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("keeps the seven-day chart coverage when storage records every thirty seconds",async()=>{
  const start=1700000000000,resolution=601;
  const points=Array.from({length:1007},(_,i)=>({...point(start+i*resolution*1000),interval_seconds:resolution}));
  const end=points.at(-1)!.time;
  const fetcher=vi.fn().mockResolvedValue({points,to:end,interval_seconds:30,resolution_seconds:resolution});
  const cache=createHistoryCache(fetcher);
  await cache.load("one",604800);
  for(let i=1;i<=20;i++)cache.checkpoint("one",point(end+i*30000),undefined,30);
  expect(cache.get("one").points).toHaveLength(1007);
  cache.checkpoint("one",point(end+630000),undefined,30);
  expect(cache.get("one").points).toHaveLength(1007);
  expect(cache.get("one").points[0].time).toBe(start+resolution*1000);
  expect(cache.get("one").points.at(-1)?.time).toBe(end+630000);
  expect(cache.get("one").stale).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("normalizes old ten-minute history without metadata after the idle interval changes",async()=>{
  const start=1700000000000;
  const fetcher=vi.fn().mockResolvedValue({points:[point(start),point(start+600000)],to:start+600000});
  const cache=createHistoryCache(fetcher);
  await cache.load("one",604800);
  expect(mergeResourceHistory(cache.get("one").points,[],30).map(p=>p.cpu)).toEqual([10,10]);
  expect(cache.get("one").resolution_seconds).toBe(601);
});

it("does not let frequent live gaps evict the beginning of a seven-day window",async()=>{
  const start=1700000000000;
  const points=Array.from({length:1007},(_,i)=>({...point(start+i*601000),interval_seconds:601}));
  const end=points.at(-1)!.time;
  const cache=createHistoryCache(vi.fn().mockResolvedValue({points,to:end,interval_seconds:30,resolution_seconds:601}));
  await cache.load("one",604800);
  for(let i=1;i<=60;i++)cache.checkpoint("one",point(end+i*15000),{time:end+(i-1)*15000+1,cpu:null,memory:null,networks:{}},30);
  const values=cache.get("one").points;
  expect(values.at(-1)!.time-values[0].time).toBeGreaterThan(167*3600000);
  expect(values.filter(p=>p.cpu!==null).length).toBeLessThanOrEqual(1008);
  expect(values.length).toBeLessThanOrEqual(2016);
  expect(cache.get("one").stale).toBe(false);
});

it("rebuckets live checkpoints received while a short window expands to seven days",async()=>{
  const start=1700000000000,end=start+1006*601000;
  let resolve!:(value:any)=>void;
  const fetcher=vi.fn().mockResolvedValueOnce({points:[point(end)],to:end,interval_seconds:30,resolution_seconds:1})
    .mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
  const cache=createHistoryCache(fetcher);
  await cache.load("one",300);
  const pending=cache.load("one",604800);
  for(let i=1;i<=120;i++)cache.checkpoint("one",point(end+i*30000),undefined,30);
  resolve({points:Array.from({length:1007},(_,i)=>({...point(start+i*601000),interval_seconds:601})),to:end,interval_seconds:30,resolution_seconds:601});
  await pending;
  const values=cache.get("one").points;
  expect(values.at(-1)!.time).toBe(end+3600000);
  expect(values.at(-1)!.time-values[0].time).toBeGreaterThan(167*3600000);
  expect(values.filter(p=>p.cpu!==null).length).toBeLessThanOrEqual(1008);
  expect(values.every(p=>p.interval_seconds!>=601)).toBe(true);
  expect(mergeResourceHistory(values,[],30).every(p=>p.cpu!==null)).toBe(true);
});
