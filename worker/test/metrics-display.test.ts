import { describe, expect, it } from "vitest";
import { diskSummary, diskGroups, volumes, memoryDetails } from "../public/metrics.js";

describe("resource summaries",()=>{
  it("sums all volumes, deduplicates aliases and counts shared pools once",()=>{
    const disks=[
      {volume_id:"a",mount:"/",total_bytes:100,used_bytes:20},
      {volume_id:"a",mount:"/alias",total_bytes:100,used_bytes:20},
      {volume_id:"b",mount:"/data",total_bytes:200,used_bytes:100},
      {volume_id:"c",capacity_group:"apfs:disk3",pool_total_bytes:500,pool_available_bytes:50,mount:"/system",total_bytes:500,used_bytes:200},
      {volume_id:"d",capacity_group:"apfs:disk3",pool_total_bytes:500,pool_available_bytes:50,mount:"/user",total_bytes:500,used_bytes:210},
    ];
    expect(volumes({disks})).toHaveLength(4);
    expect(diskSummary({disks})).toEqual({total_bytes:800,used_bytes:570});
  });
  it("does not invent usage for legacy shared pools, and accepts zero available capacity",()=>{
    const old={volume_id:"system",mount:"/",capacity_group:"apfs:disk3",total_bytes:500,used_bytes:100};
    const data={...old,volume_id:"data",mount:"/data",used_bytes:200};
    expect(diskSummary({disks:[old,data]})).toEqual({total_bytes:500,used_bytes:null});
    const measured={...data,pool_total_bytes:500,pool_available_bytes:0};
    expect(diskSummary({disks:[old,measured]})).toEqual({total_bytes:500,used_bytes:500});
    expect(diskSummary({disks:[measured,old]})).toEqual({total_bytes:500,used_bytes:500});
  });
  it("keeps unavailable memory fields distinct from zero and swap separate from RAM",()=>{
    const rows=memoryDetails({total_bytes:1000,used_bytes:400,free_bytes:0,swap_supported:true,swap_used_bytes:20,swap_total_bytes:100});
    expect(rows.find(r=>r.label==="缓存")?.value).toBeUndefined();
    expect(rows.find(r=>r.label==="空闲")?.value).toBe(0);
    expect(rows[0]).toEqual({label:"物理内存",value:400,total:1000});
    expect(diskSummary({})).toBeNull();
  });
  it("groups only OS-reported physical parents and retains spanned and unknown volumes",()=>{
    const a={id:"disk0",name:"磁盘 0",size_bytes:1000},b={id:"disk1",name:"磁盘 1",size_bytes:2000};
    const disks=[
      {volume_id:"one",mount:"C:\\",device:"C:",total_bytes:100,used_bytes:20,physical_disks:[a]},
      {volume_id:"two",mount:"D:\\",device:"D:",total_bytes:200,used_bytes:50,physical_disks:[a,b]},
      {volume_id:"unknown",mount:"/",device:"/dev/sda9",total_bytes:50,used_bytes:10},
    ];
    const groups=diskGroups({disks});
    expect(groups.map(g=>[g.kind,g.name,g.volumes.length])).toEqual([["physical","磁盘 0",2],["physical","磁盘 1",1],["unmapped","未识别物理归属",1]]);
    expect(groups[0].size_bytes).toBe(1000);
    expect(diskSummary({disks})).toEqual({total_bytes:350,used_bytes:80});
  });
});
