import {cpuDetails,memoryDetails,diskGroups,volumeName,diskSummary} from "./metrics.js";
import {chartGeometry,CHART_RANGES,DEFAULT_CHART_SECONDS} from "./resource-charts.js";
import {getDeviceIcon} from "./device-icons.js";

const formatter = new Intl.NumberFormat("zh-CN",{maximumFractionDigits:1});
const known = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const percent = value => known(value) ? `${formatter.format(value)}%` : "—";
function bytes(value) { if(!known(value))return "—";let unit=0;while(value>=1024&&unit<4){value/=1024;unit++;}return `${formatter.format(value)} ${["B","KiB","MiB","GiB","TiB"][unit]}`; }
const clock = (value,seconds) => value ? new Date(value).toLocaleString("zh-CN",{...(seconds>=86400?{month:"2-digit",day:"2-digit"}:{}),hour:"2-digit",minute:"2-digit",...(seconds<3600?{second:"2-digit"}:{}),hour12:false}) : "—";
function uptime(value){if(!known(value))return "—";const minutes=Math.floor(value/60);return `${Math.floor(minutes/1440)} 天 ${Math.floor(minutes/60)%24} 小时 ${minutes%60} 分钟`;}
const add = (parent,tag,className,text) => {const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;parent.append(el);return el;};
function svgElement(parent,tag,attributes,text){const el=document.createElementNS("http://www.w3.org/2000/svg",tag);for(const [key,value]of Object.entries(attributes))el.setAttribute(key,String(value));if(text!==undefined)el.textContent=text;parent.append(el);return el;}
function chart(parent,points,series,maximum,key,ranges,options){
  const seconds=ranges.get(key)||DEFAULT_CHART_SECONDS,toolbar=add(parent,"div","resource-chart-toolbar"),select=add(toolbar,"select");
  select.dataset.chartKey=key;select.dataset.resourceFocus=`chart-${key}`;select.setAttribute("aria-label",`${series.map(s=>s.label).join("、")}时间范围`);
  for(const range of CHART_RANGES){const option=add(select,"option","",range.label);option.value=String(range.seconds);}
  select.value=String(seconds);select.addEventListener("change",()=>options.onRangeChange?.(Number(select.value)));
  const model=chartGeometry(points,series.map(s=>s.key),maximum,seconds*1000,options.endTime),box=add(parent,"div","resource-chart");
  const plot=add(box,"div","resource-chart-plot"),svg=svgElement(plot,"svg",{viewBox:"40 0 592 96",preserveAspectRatio:"none",role:"img","aria-label":series.map(s=>s.label).join("、")+"历史曲线"});
  for(const tick of model.ticks){svgElement(svg,"line",{x1:40,x2:632,y1:tick.y,y2:tick.y,class:"resource-chart-grid"});const label=add(box,"span","resource-chart-tick",maximum?percent(tick.value):bytes(tick.value));label.style.top=`calc((100% - 16px) * ${tick.y/96})`;}
  for(const [index,line]of model.series.entries()){
    svgElement(svg,"path",{d:line.path,fill:"none",stroke:series[index].color,"stroke-width":2,"stroke-linecap":"round","stroke-linejoin":"round","vector-effect":"non-scaling-stroke",...(index?{"stroke-dasharray":"5 3"}:{})});
    for(const marker of line.markers)svgElement(svg,"circle",{cx:marker.x,cy:marker.y,r:2.2,fill:series[index].color});
  }
  const axis=add(box,"div","resource-chart-axis");for(const time of [model.first,(model.first+model.last)/2,model.last])add(axis,"span","",clock(time,seconds));
}
function facts(parent,rows){const dl=add(parent,"dl","compact-facts");for(const [label,value]of rows){const item=add(dl,"div",label==="设备 ID"?"fact-wide":"");add(item,"dt","",label);add(item,"dd","",value);}return dl;}
function section(parent,title,value){const box=add(parent,"section","resource-section"),header=add(box,"div","resource-section-heading");add(header,"h2","",title);if(value)add(header,"strong","",value);return box;}

export function renderResourceDetail(root,node,points=[],options={}){
  const sameNode=root.dataset.nodeId===node?.node_id;
  const expanded=new Set(sameNode?[...root.querySelectorAll("details[data-disk-id][open]")].map(d=>d.dataset.diskId):[]);
  const focus=sameNode&&root.contains(document.activeElement)?document.activeElement.dataset.resourceFocus:null;
  const ranges=new Map(sameNode?[...root.querySelectorAll("select[data-chart-key]")].map(s=>[s.dataset.chartKey,Number(s.value)]):[]);
  root.replaceChildren();root.className="compact-resources";root.dataset.nodeId=node?.node_id||"";
  const back=add(root,"a","back-link","← 返回总览");back.href="#/";back.dataset.resourceFocus="back";
  if(!node){add(root,"p","empty-state","设备不存在或已移除。");return;}
  const heading=add(root,"div","resource-device-heading"),icon=svgElement(heading,"svg",{class:"resource-device-icon",viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":1.7,"stroke-linecap":"round","stroke-linejoin":"round","aria-hidden":"true"});
  for(const d of getDeviceIcon(node.icon).paths)svgElement(icon,"path",{d});
  add(heading,"h2","",node.name);add(heading,"span",node.connected?"state-online":"state-offline",node.connected?"在线":"离线");
  const metrics=node.metrics||{},host=node.host||{};
  options={...options,endTime:Math.max(node.last_seen||0,points.at(-1)?.time||0)||Date.now()};
  add(root,"p","resource-device-meta",`${host.os||"—"} / ${host.arch||"—"} · ${host.hostname||node.name}${!node.connected?` · 最后在线 ${node.last_seen?new Date(node.last_seen).toLocaleString("zh-CN",{hour12:false}):"—"}`:""}`);
  if(options.historyError)add(root,"p","resource-empty",options.historyError);
  const pair=add(root,"div","resource-pair");
  const cpu=section(pair,"处理器",percent(metrics.cpu_percent));
  if(host.cpu_model)add(cpu.querySelector("h2"),"span","processor-model",host.cpu_model);
  chart(cpu,points.map(p=>({time:p.time,cpu:p.cpu})),[{key:"cpu",label:"处理器使用率",color:"var(--resource-cpu)"}],100,"cpu",ranges,options);
  facts(cpu,[["物理核心",host.physical_cpus||"—"],["逻辑处理器 / vCPU",host.cpus||"—"],...cpuDetails(metrics).slice(1).map(row=>[row.label,percent(row.value)])]);
  const memory=section(pair,"内存",metrics.memory?`${bytes(metrics.memory.used_bytes)} / ${bytes(metrics.memory.total_bytes)}`:"—");
  chart(memory,points.map(p=>({time:p.time,memory:p.memory})),[{key:"memory",label:"物理内存使用率",color:"var(--resource-memory)"}],100,"memory",ranges,options);
  facts(memory,memoryDetails(metrics.memory).slice(1).map(row=>[row.label,bytes(row.value)+(row.total!==undefined?` / ${bytes(row.total)}`:"")]));
  const nics=Array.isArray(metrics.networks)?metrics.networks.filter(n=>n&&typeof n.name==="string"):[];
  const network=section(root,"网络",`${nics.length} 张网卡`),networkGrid=add(network,"div","nic-grid");
  for(const nic of nics){
    const item=add(networkGrid,"article","nic-resource"),head=add(item,"div","nic-heading");add(head,"h3","",nic.name);
    const rates=add(head,"div","nic-rates");
    add(rates,"span","network-rx",`↓ ${node.connected&&known(nic.rx_bytes_per_second)?bytes(nic.rx_bytes_per_second)+"/s":"—"}`);
    add(rates,"span","network-tx",`↑ ${node.connected&&known(nic.tx_bytes_per_second)?bytes(nic.tx_bytes_per_second)+"/s":"—"}`);
    chart(item,points.map(p=>({time:p.time,rx:p.networks?.[nic.name]?.rx,tx:p.networks?.[nic.name]?.tx})),[{key:"rx",label:nic.name+"接收速率",color:"var(--resource-rx)"},{key:"tx",label:nic.name+"发送速率",color:"var(--resource-tx)"}],undefined,`nic:${nic.name}`,ranges,options);
    const totals=add(item,"div","nic-totals");add(totals,"span","",`累计接收 ${bytes(nic.rx_bytes)}`);add(totals,"span","",`累计发送 ${bytes(nic.tx_bytes)}`);
  }
  if(!nics.length)add(network,"p","resource-empty","暂无可读取的网卡。");
  const sum=diskSummary(metrics),storage=section(root,"磁盘",sum?`逻辑卷 ${bytes(sum.used_bytes)} / ${bytes(sum.total_bytes)}`:"");
  for(const group of diskGroups(metrics)){
    const item=add(storage,"details","disk-resource");item.dataset.diskId=group.id;item.open=expanded.has(group.id);
    const summary=add(item,"summary","disk-heading");summary.dataset.resourceFocus=group.id;
    add(summary,"span","disk-chevron","›");add(summary,"strong","",group.name);
    add(summary,"span","disk-size",group.kind==="physical"&&known(group.size_bytes)?bytes(group.size_bytes):"");add(summary,"span","disk-volume-count",`${group.volumes.length} 个逻辑卷`);
    const wrap=add(item,"div","table-wrap"),table=add(wrap,"table","compact-volume-table"),thead=add(table,"thead"),row=add(thead,"tr");
    for(const title of ["逻辑卷","文件系统","已用 / 总计","使用率"])add(row,"th","",title);
    const tbody=add(table,"tbody");
    for(const disk of group.volumes){
      const row=add(tbody,"tr"),name=add(row,"td");add(name,"span","",volumeName(disk));if(disk.mount)add(name,"small","",disk.mount);
      if(disk.physical_disks?.length>1)add(name,"small","","跨磁盘卷");else if(disk.capacity_group)add(name,"small","","共享存储池");
      add(row,"td","",disk.filesystem||"—");add(row,"td","",`${bytes(disk.used_bytes)} / ${bytes(disk.total_bytes)}`);
      const ratio=disk.total_bytes>0?disk.used_bytes/disk.total_bytes*100:null,cell=add(row,"td","",percent(ratio));
      const meter=add(cell,"div",`meter ${!known(ratio)?"usage-unknown":ratio>=85?"usage-critical":ratio>=60?"usage-warning":"usage-normal"}`),fill=add(meter,"span");fill.style.width=`${known(ratio)?Math.min(100,ratio):0}%`;
    }
  }
  if(!storage.querySelector("details"))add(storage,"p","resource-empty","暂无可读取的卷。");
  const system=section(root,"系统信息");system.classList.add("system-information");
  facts(system,[["主机名",host.hostname||"—"],["操作系统",host.os||"—"],["架构",host.arch||"—"],["内核",host.kernel||"—"],
    ["CPU 型号",host.cpu_model||"—"],["总内存",bytes(metrics.memory?.total_bytes)],["总存储容量",bytes(sum?.total_bytes)],
    ["运行时间",uptime(metrics.uptime_seconds)],["客户端版本",host.agent_version||"—"],["设备 ID",node.node_id||"—"],
    ...(host.ip?[["IP 地址",host.ip]]:[])]);
  if(focus)for(const el of root.querySelectorAll("[data-resource-focus]"))if(el.dataset.resourceFocus===focus){el.focus({preventScroll:true});break;}
}
