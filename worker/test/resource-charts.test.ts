import {expect,it} from "vitest";
import {chartGeometry,recordSample,mergeResourceHistory,type ResourcePoint} from "../public/resource-charts.js";

it("uses receipt time across device clock rollback and deduplicates replayed reports",()=>{
  const history=new Map<string,ResourcePoint[]>();
  const start=1700000000000;
  const node={node_id:"device",connected:true,last_seen:start,metrics:{time:new Date(start).toISOString(),cpu_percent:10}};
  recordSample(history,node);
  node.last_seen+=5000;node.metrics.time=new Date(start-60000).toISOString();recordSample(history,node);
  node.last_seen+=5000;node.metrics.time=new Date(start-55000).toISOString();recordSample(history,node);
  recordSample(history,node);
  expect(history.get("device")!.map(p=>p.time)).toEqual([start,start+5000,start+10000]);
  node.last_seen=start;recordSample(history,node);
  expect(history.get("device")).toHaveLength(3);
});

it("gives RX/TX a shared scale and joins valid readings across missing samples",()=>{
  const graph=chartGeometry([{time:1,rx:100,tx:50},{time:2,rx:null,tx:100},{time:3,rx:2000,tx:0}],["rx","tx"]);
  expect(graph.maximum).toBe(2200);
  expect(graph.series[0].path.match(/M/g)).toHaveLength(1);
  expect(graph.series[0].path.match(/L/g)).toHaveLength(1);
  expect(graph.series[1].path.match(/L/g)).toHaveLength(2);
  expect(graph.series.every(s=>!s.path.includes("NaN"))).toBe(true);
  expect(chartGeometry([], ["rx","tx"]).maximum).toBe(1024);
  expect(chartGeometry([{time:0,cpu:120}], ["cpu"],100).series[0].path).toBe("M632.0,8.0");
});
it("keeps only real bounded samples; duplicate loads, reconnects and counter resets are not invented traffic",()=>{
  const history=new Map<string,ResourcePoint[]>();
  const node={node_id:"device",connected:true,metrics:{time:"",networks:[] as Record<string,unknown>[],memory:{total_bytes:100,used_bytes:20},cpu_percent:10}};
  for(let i=0;i<150;i++){
    node.metrics.time=new Date(1700000000000+i*5000).toISOString();
    node.metrics.networks=[{name:"eth0",rx_bytes_per_second:i,tx_bytes_per_second:0}];
    recordSample(history,node);recordSample(history,node);
  }
  expect(history.get("device")).toHaveLength(120);
  expect(history.get("device")!.at(-1)!.networks.eth0).toEqual({rx:149,tx:0});
  node.metrics.time=new Date(1700001000000).toISOString();
  node.metrics.networks=[{name:"eth0",counter_reset:true}];
  recordSample(history,node);
  const rows=history.get("device")!;
  expect(rows.at(-2)!.cpu).toBeNull();
  expect(rows.at(-1)!.networks.eth0).toEqual({rx:null,tx:null});
  expect(rows.at(-1)!.memory).toBe(20);
  node.connected=false;node.metrics.time=new Date(1700001005000).toISOString();recordSample(history,node);
  expect(rows.at(-1)!.time).toBe(1700001000000);
});

it("clips to a fixed latest time window instead of stretching all samples",()=>{
  const end=1700000000000;
  const graph=chartGeometry([{time:end-86400000,cpu:99},{time:end-60000,cpu:20},{time:end,cpu:40}],["cpu"],100,300000);
  expect(graph.first).toBe(end-300000);
  expect(graph.last).toBe(end);
  expect(graph.count).toBe(2);
  expect(graph.series[0].path).toBe("M513.6,72.0 L632.0,56.0");
  const single=chartGeometry([{time:end-60000,cpu:20}],["cpu"],100,300000,end);
  expect(single.series[0].markers).toEqual([{x:513.6,y:72}]);
  const empty=chartGeometry([],["cpu"],100,300000,end);
  expect(empty.first).toBe(end-300000);
  expect(empty.series[0].path).toBe("");
});

it("retains sparse seven-day history beyond the live buffer limit and scales only visible values",()=>{
  const points=Array.from({length:1008},(_,i)=>({time:1700000000000+i*600000,rx:i===0?100000:1000}));
  expect(chartGeometry(points,["rx"],undefined,604800000).count).toBe(1008);
  expect(chartGeometry(points,["rx"],undefined,300000).maximum).toBe(1100);
});

it("merges historical and live points without bridging offline gaps or overwriting live gaps",()=>{
  const point=(time:number,cpu:number|null):ResourcePoint=>({time,cpu,memory:null,networks:{}});
  const points=mergeResourceHistory([point(1,1),point(600001,2),point(1200001,3)],[point(600001,20),point(600002,null),point(1200001,30)]);
  expect(points.map(p=>p.cpu)).toEqual([1,20,null,30]);
  expect(mergeResourceHistory([point(1,1),point(3600001,2)],[]).map(p=>p.cpu)).toEqual([1,null,2]);
  expect(mergeResourceHistory([point(1,1),point(2,2)],[point(1,10)]).map(p=>p.cpu)).toEqual([10,2]);
});

it("uses each historical recording interval and chart resolution for missing-data gaps",()=>{
  const point=(time:number,interval_seconds:number):ResourcePoint=>({time,interval_seconds,cpu:10,memory:20,networks:{}});
  expect(mergeResourceHistory([point(1,3600),point(3600001,3600)],[],30)).toHaveLength(2);
  expect(mergeResourceHistory([point(1,30),point(120001,30)],[],600).map(p=>p.cpu)).toEqual([10,null,10]);
  expect(mergeResourceHistory([point(1,601),point(601001,601)],[],30)).toHaveLength(2);
  // A change to shorter intervals must not mark the older cadence as missing.
  expect(mergeResourceHistory([point(1,3600),point(3600001,30)],[],30)).toHaveLength(2);
});

it("renders one current value for a replayed initial timestamp instead of a vertical spike",()=>{
  const time=1700000000000;
  const initial=chartGeometry([{time,cpu:0},{time,cpu:80},{time,cpu:20}],["cpu"],100,60000,time);
  expect(initial.count).toBe(1);
  expect(initial.series[0].path).toBe("M632.0,72.0");
  expect(initial.series[0].markers).toEqual([{x:632,y:72}]);
  const next=chartGeometry([{time,cpu:0},{time:time+5000,cpu:30},{time,cpu:20}],["cpu"],100,60000,time+5000);
  expect(next.series[0].path).toBe("M582.7,72.0 L632.0,64.0");
  expect(next.series[0].markers).toEqual([]);
});

it("joins surrounding real samples without filling missing initial or reconnect history",()=>{
  const time=1700000000000;
  const graph=chartGeometry([{time,cpu:0},{time:time+1,cpu:null},{time:time+30000,cpu:100}],["cpu"],100,60000,time+30000);
  expect(graph.count).toBe(3);
  expect(graph.series[0].path).toBe("M336.0,88.0 L632.0,8.0");
  expect(graph.series[0].markers).toEqual([]);
});

it("skips missing NIC values independently without creating zero traffic or initial data",()=>{
  const graph=chartGeometry([{time:1,rx:null},{time:2,rx:100},{time:3,tx:50},{time:4,rx:200,tx:100}],["rx","tx"]);
  expect(graph.series[0].path).toBe("M237.3,80.2 L632.0,72.4");
  expect(graph.series[1].path).toBe("M434.7,84.1 L632.0,80.2");
  expect(graph.series.every(line=>line.markers.length===0)).toBe(true);
  const empty=chartGeometry([{time:1,rx:null},{time:2}],["rx","tx"]);
  expect(empty.series.every(line=>line.path===""&&line.markers.length===0)).toBe(true);
  const single=chartGeometry([{time:1,rx:null},{time:2,rx:0},{time:3,rx:null}],["rx"]);
  expect(single.series[0].markers).toEqual([{x:336,y:88}]);
});
