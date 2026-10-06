import { expect, it } from "vitest";
import { validReport, validHost } from "../src/model";

const id="a".repeat(32);
const report={protocol:1,node_id:id,session:"b".repeat(32),sequence:1,host:{hostname:"fixture",os:"linux",arch:"arm64",cpus:2,agent_version:"test"},metrics:{time:"2026-10-05T00:00:00Z"}};
it("accepts optional CPU model metadata and rejects malformed values",()=>{
  expect(validHost(report.host)).toBe(true);
  for(const cpu_model of ["Apple M2","Intel(R) Xeon(R) CPU", "ARM Cortex-A53"])
    expect(validHost({...report.host,cpu_model})).toBe(true);
  for(const cpu_model of [null,42,"x".repeat(129),"name\nspoof","name\u0000"])
    expect(validHost({...report.host,cpu_model})).toBe(false);
});
it("validates paired shared-pool counters and keeps legacy reports valid",()=>{
  const disk={mount:"/",total_bytes:100,used_bytes:20,capacity_group:"apfs:disk3",pool_total_bytes:200,pool_available_bytes:0};
  const payload=(value:unknown)=>({...report,metrics:{...report.metrics,disks:[value]}});
  expect(validReport(payload(disk),id)).toBe(true);
  for(const bad of [{pool_available_bytes:undefined},{pool_available_bytes:201},{pool_available_bytes:-1},{capacity_group:""},{pool_total_bytes:Infinity}])expect(validReport(payload({...disk,...bad}),id)).toBe(false);
});
it("accepts older clients and optional detail fields without treating Linux commit as physical memory",()=>{
  expect(validReport(report,id)).toBe(true);
  expect(validReport({...report,metrics:{...report.metrics,memory:{total_bytes:1000,used_bytes:400,free_bytes:0,committed_bytes:3000,commit_limit_bytes:1500},cpu_detail:{user_percent:20,system_percent:10,idle_percent:70},disks:[{mount:"/",volume_id:"x",device:"/dev/sda1",total_bytes:100,used_bytes:20}]}},id)).toBe(true);
});
it("rejects corrupt detail counters and oversized volume inventories",()=>{
  for(const value of [-1,101,NaN,Infinity,"10"]){expect(validReport({...report,metrics:{...report.metrics,cpu_detail:{user_percent:value}}},id)).toBe(false);}
  expect(validReport({...report,metrics:{...report.metrics,memory:{total_bytes:100,used_bytes:50,cached_bytes:-1}}},id)).toBe(false);
  expect(validReport({...report,metrics:{...report.metrics,disks:Array(33).fill({mount:"/",total_bytes:10,used_bytes:1})}},id)).toBe(false);
});
it("bounds physical disk metadata without requiring it from older devices",()=>{
  const disk={mount:"/",total_bytes:100,used_bytes:20,physical_disks:[{id:"linux:sda",name:"/dev/sda",size_bytes:1000}]};
  const payload=(physical_disks:unknown)=>({...report,metrics:{...report.metrics,disks:[{...disk,physical_disks}]}});
  expect(validReport(payload(disk.physical_disks),id)).toBe(true);
  expect(validReport(payload(undefined),id)).toBe(true);
  expect(validReport(payload([...disk.physical_disks,...disk.physical_disks]),id)).toBe(false);
  expect(validReport(payload(Array.from({length:9},(_,i)=>({id:String(i),name:"disk"}))),id)).toBe(false);
  expect(validReport(payload([{id:"x",name:"disk",size_bytes:-1}]),id)).toBe(false);
});
