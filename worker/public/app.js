"use strict";
import { DEVICE_ICONS, normalizeDeviceIcon, getDeviceIcon } from "./device-icons.js";
import { diskSummary } from "./metrics.js";
import { renderResourceDetail } from "./resource-detail.js";
import { recordSample,mergeResourceHistory,DEFAULT_CHART_SECONDS } from "./resource-charts.js";
import { createHistoryCache } from "./resource-history.js";
import { createPanelRefresh } from "./panel-refresh.js";
const $ = id => document.getElementById(id);
const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const quotaDurationFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 3 });
const quotaPercentFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const number = x => numberFormatter.format(x || 0);
const bytes = x => { if (!Number.isFinite(x) || x < 0) return "—"; const units = ["B", "KiB", "MiB", "GiB", "TiB"]; let i=0; while(x>=1024 && i<4){x/=1024;i++;} return `${number(x)} ${units[i]}`; };
let state, socket, reconnect, retry = 0, heartbeat, dirty = false;
let session = null, authLocked = true, sessionTimer;
const panelRefresh = createPanelRefresh(loadState,{enabled:()=>hasSession()&&!document.hidden});
const nodeRows = new Map();
const nodePanels = new Map();
const resourceHistory = new Map();
const storedHistory = createHistoryCache((id,range)=>api(`/panel/api/nodes/${encodeURIComponent(id)}/history?range=${range}`));
const groupRows = new Map();
let currentInvitation = null, invitationBusy = false, invitationCopied = false, lastInvitationCheck = 0, invitationChecking = false, invitationClosed = false;
let page = "overview", configNodeId = null, configIcon = "server", configBusy = false, groupBusy = false;
let deleteNodeId = null, deleteNodeName = "", deleteBusy = false;
let nodeUpdateChecking = false;
const updateErrors = {
  update_platform_unavailable:"此设备暂没有可用的更新包。",
  update_repository_not_configured:"请先在部署配置中填写固定 GitHub 仓库（owner/repository）。",
  release_not_found:"固定仓库暂无可用的公开稳定版 Release，请先完成发布。",
  release_manifest_missing:"GitHub Release 缺少有效的 update-manifest.json，请检查发布资源是否完整。",
  invalid_github_release:"GitHub 返回的发布信息无效，请检查稳定版标签及发布资源。",
  github_rate_limited:"GitHub 暂时限制了请求次数，请等待后重试。",
  github_timeout:"连接 GitHub 超时，请稍后重试。",
  github_unavailable:"GitHub 暂时不可用，请稍后重试。",
  unsafe_release_redirect:"GitHub 下载跳转到不允许的地址，已停止更新，请检查发布来源。",
  release_changed:"同一已发布版本的内容发生变化，已拒绝分发；请发布新的版本号。",
  release_version_regressed:"GitHub 最新版本低于已经检查过的版本，已拒绝降级。",
  use_update_check:"请使用“检查 GitHub 版本”；安装包会在设备请求时按需下载。",
  update_check_required:"请先检查 GitHub 版本，再尝试下载。",
  updates_disabled:"本网络尚未启用更新分发。",
  update_not_found:"未找到此版本的安装包，请重新检查更新。",
  update_metadata_too_large:"GitHub 发布清单超过允许大小，已停止处理。",
  invalid_update_config:"分发路径只允许小写字母、数字、短横线和斜杠，最长 64 个字符，不能使用保留路径。",
  update_path_history_full:"已保留 8 个旧分发路径，请保持当前路径，避免旧客户端下载地址失效。",
  invalid_update_manifest:"GitHub 更新清单的格式、架构、文件名、大小或 SHA-256 无效，请检查 Release 资源。",
  asset_size_mismatch:"GitHub 安装包大小与更新清单不一致，请检查 Release 资源。",
  payload_too_large:"更新数据超过允许大小，已停止处理。",
  update_temporarily_unavailable:"更新服务暂时不可用，请稍后重试。",
};
function notice(text, error = false) { $("notice").textContent = text; $("notice").className = error ? "error" : ""; $("notice").hidden = !text; }
async function api(path, method="GET", body) {
  if (path !== "/panel/api/session" && !hasSession()) throw new Error("请先登录。");
  const r = await fetch(path, { method, credentials:"same-origin", redirect:"manual", cache:"no-store", headers:body ? {"Content-Type":"application/json"} : {}, body:body ? JSON.stringify(body) : undefined });
  if (r.type === "opaqueredirect" || r.redirected || r.headers.get("Content-Type")?.includes("text/html")) { lockPanel("access_required"); throw new Error("请重新登录。"); }
  const result = await r.json();
  if (r.status === 401 || result.code === "admin_required" || result.code === "access_not_configured") { lockPanel(result.code); throw new Error($("login-description").textContent); }
  if (path !== "/panel/api/session" && authLocked) throw new Error("请先登录。");
  if (!r.ok) { const error = new Error(updateErrors[result.code] || ({ invalid_settings:"观看间隔需为 2–300 秒，无人观看间隔需为 30–86400 秒，且不小于观看间隔。", invalid_node_group:"分组名称需为 1–64 个字符。", invalid_nickname:"名字最多 128 个字符，不能包含控制字符。", invalid_icon:"请选择列表中的设备图标。", invalid_group_members:"请选择有效的设备分组。", group_name_exists:"已有同名分组。", too_many_groups:"最多支持 50 个分组。", node_group_not_found:"分组已删除，请刷新。", node_not_found:"设备已删除，请刷新。", admin_required:"此账户没有管理权限。" })[result.code] || `操作失败：${result.code || r.status}`); error.code=result.code; error.retryAfterSeconds=Number(result.retry_after_seconds)||0; throw error; }
  return result;
}
function inputSettings() { const active=Number($("active").value), idle=Number($("idle").value); if(!Number.isInteger(active)||active<2||active>300||!Number.isInteger(idle)||idle<30||idle>86400||idle<active) throw new Error("面板开启间隔需为 2–300 秒，且不能大于面板关闭间隔。"); return { active_seconds:active, idle_seconds:idle }; }
function settings(s) { if (state) state.settings=s; if(!dirty){$("active").value=s.active_seconds;const select=$("idle");select.querySelector("[data-legacy]")?.remove();if(![120,300,600].includes(s.idle_seconds)){const option=document.createElement("option");option.value=s.idle_seconds;option.textContent=`${s.idle_seconds} 秒（当前）`;option.dataset.legacy="true";select.append(option);}select.value=s.idle_seconds;} }
function addCell(row, text) { const c = document.createElement("td"); c.textContent=text; row.append(c); return c; }
function visible(n,filterId="group-filter") {
  const filter=$(filterId).value,query=filterId==="group-filter"?$("device-search").value.trim().toLowerCase():"";
  return (!query||`${n.name} ${n.node_id} ${n.host?.hostname||""}`.toLowerCase().includes(query))&&(filter==="all"||(filter==="ungrouped"?!n.group_id:n.group_id===filter));
}
function groupOptions(id, initial) {
  const select=$(id),previous=select.value;select.replaceChildren();
  for(const [value,label] of [...initial,...(state.node_groups||[]).map(g=>[g.id,g.name])]){const option=document.createElement("option");option.value=value;option.textContent=label;select.append(option);}
  if([...select.options].some(o=>o.value===previous))select.value=previous;
}
function renderNodes() {
  const ids=new Set(state.nodes.map(n=>n.node_id));
  for(const id of resourceHistory.keys())if(!ids.has(id))resourceHistory.delete(id);
  for(const id of storedHistory.keys())if(!ids.has(id))storedHistory.delete(id);
  for(const [id,row] of nodeRows)if(!ids.has(id)){row.remove();nodeRows.delete(id);}
  for(const [id,panel] of nodePanels)if(!state.nodes.some(n=>n.node_id===id&&n.state==="approved")){panel.remove();nodePanels.delete(id);}
  for(const n of state.nodes){recordResourceSample(n);renderNode(n);$("nodes").append(nodeRows.get(n.node_id));}
  const count=state.nodes.filter(n=>visible(n)).length;$("empty").hidden=count>0;
  $("empty").textContent=state.nodes.length?"没有符合条件的设备。":"暂无设备，请先添加设备。";
  $("overview-empty").hidden=state.nodes.some(n=>n.state==="approved"&&visible(n,"overview-group-filter"));
  $("overview-empty").textContent=state.nodes.some(n=>n.state==="approved")?"此分组暂无已加入设备。":"暂无已加入设备。";
  if(page==="detail")renderDetail();
}
function usageClass(value){return !Number.isFinite(value)||value<0?"usage-unknown":value>=85?"usage-critical":value>=60?"usage-warning":"usage-normal";}
function metricRate(networks,key){const values=networks.map(n=>n[key]);return values.length&&values.every(value=>Number.isFinite(value)&&value>=0)?values.reduce((sum,value)=>sum+value,0):null;}
function addElement(parent,tag,className,text){const element=document.createElement(tag);if(className)element.className=className;if(text!==undefined)element.textContent=text;parent.append(element);return element;}
function addDeviceIcon(parent,value){const icon=getDeviceIcon(value),svg=document.createElementNS("http://www.w3.org/2000/svg","svg");for(const [name,content] of Object.entries({viewBox:"0 0 24 24",fill:"none",stroke:"currentColor","stroke-width":"1.7","stroke-linecap":"round","stroke-linejoin":"round","aria-hidden":"true",focusable:"false"}))svg.setAttribute(name,content);svg.classList.add("device-icon");for(const d of icon.paths){const path=document.createElementNS("http://www.w3.org/2000/svg","path");path.setAttribute("d",d);svg.append(path);}parent.append(svg);return svg;}
function addPanelMetric(panel,label,value,ratio=null,detail=""){const item=addElement(panel,"div","panel-metric");addElement(item,"span","metric-label",label);addElement(item,"strong","metric-value",value);const meter=addElement(item,"div",`panel-meter ${usageClass(ratio)}`);if(Number.isFinite(ratio)){const fill=addElement(meter,"span");fill.style.width=`${Math.max(0,Math.min(100,ratio))}%`;}if(detail)item.title=detail;item.setAttribute("aria-label",`${label} ${value}${detail?`，${detail}`:""}`);return item;}
function resourcePercent(resource){return resource&&Number.isFinite(resource.used_bytes)&&Number.isFinite(resource.total_bytes)&&resource.used_bytes>=0&&resource.total_bytes>0&&resource.used_bytes<=resource.total_bytes?resource.used_bytes/resource.total_bytes*100:null;}
function renderPanel(n){if(n.state!=="approved")return;let panel=nodePanels.get(n.node_id);if(!panel){panel=document.createElement("a");panel.href=`#/server/${n.node_id}`;panel.setAttribute("aria-label",`查看 ${n.name} 的详情`);nodePanels.set(n.node_id,panel);$("node-panels").append(panel);}panel.className=`node-panel${n.connected?"":" offline"}`;panel.hidden=!visible(n,"overview-group-filter");panel.replaceChildren();
  const head=addElement(panel,"div","panel-heading"),platform=addElement(head,"div","panel-platform");addDeviceIcon(platform,n.icon);addElement(platform,"span","",n.host?.os||"—");platform.title=`${getDeviceIcon(n.icon).label} · ${n.host?.os||"未知系统"} ${n.host?.arch||""}`;panel.setAttribute("aria-label",`查看 ${n.name} 的详情，${n.connected?(n.last_seen?"在线":"待上报"):"离线"}`);if(n.connected&&!n.last_seen)addElement(head,"span","panel-state pending","待上报");const identity=addElement(panel,"div","panel-identity");addElement(identity,"h2","",n.name).title=n.name;const group=(state.node_groups||[]).find(g=>g.id===n.group_id)?.name||"未分组";addElement(identity,"span","panel-group",group).title=group;
  const m=n.metrics||{},metrics=addElement(panel,"div","panel-metrics"),cpu=Number.isFinite(m.cpu_percent)&&m.cpu_percent>=0&&m.cpu_percent<=100?m.cpu_percent:null,memory=resourcePercent(m.memory),disks=Array.isArray(m.disks)?m.disks.filter(d=>d&&typeof d==="object"):[],disk=diskSummary(m),diskPercent=resourcePercent(disk);
  addPanelMetric(metrics,"CPU",cpu===null?"—":`${number(cpu)}%`,cpu);addPanelMetric(metrics,"内存",memory===null?"—":`${number(memory)}%`,memory,memory===null?"":`${bytes(m.memory.used_bytes)} / ${bytes(m.memory.total_bytes)}`);const diskItem=addPanelMetric(metrics,"磁盘",diskPercent===null?"—":`${number(diskPercent)}%`,diskPercent,diskPercent===null?"":`${bytes(disk.used_bytes)} / ${bytes(disk.total_bytes)}`);diskItem.title=disks.map(d=>`${d.mount}: ${bytes(d.used_bytes)} / ${bytes(d.total_bytes)}`).join(" · ");
  const networks=Array.isArray(m.networks)?m.networks.filter(x=>x&&typeof x==="object"):[],rx=metricRate(networks,"rx_bytes_per_second"),tx=metricRate(networks,"tx_bytes_per_second"),network=addElement(panel,"div","panel-network");addElement(network,"span","",`↓ ${n.connected&&rx!==null?`${bytes(rx)}/s`:"—"}`);addElement(network,"span","",`↑ ${n.connected&&tx!==null?`${bytes(tx)}/s`:"—"}`);network.setAttribute("aria-label","网络接收和发送");const updated=n.last_seen?new Date(n.last_seen):null;addElement(panel,"small","panel-updated",updated?`${n.connected?"更新":"最后在线"} ${n.connected?updated.toLocaleTimeString():updated.toLocaleString()}`:"尚未收到数据");
}
function renderNode(n) {
  let row=nodeRows.get(n.node_id); if(!row){row=document.createElement("tr");nodeRows.set(n.node_id,row);$("nodes").append(row);} row.replaceChildren();
  row.hidden=!visible(n);
  const nameCell=addCell(row,""),device=addElement(nameCell,"div","device-cell"),icon=addElement(device,"span","device-cell-icon"),name=addElement(device,"div","device-cell-copy");addDeviceIcon(icon,n.icon);addElement(name,"span","device-name",n.name);const host=document.createElement("small");host.textContent=`${n.host?.os || ""} / ${n.host?.arch || ""} · ${n.host?.hostname || ""}`;name.append(host);
  const identity=document.createElement("small");identity.textContent=`ID ${n.node_id.slice(0,12)}…`;identity.title=n.node_id;name.append(identity);
  addCell(row,(state.node_groups||[]).find(g=>g.id===n.group_id)?.name||"未分组");
  const status=addCell(row,n.state==="approved" ? (n.connected ? "在线" : "离线") : n.state==="pending" ? "待加入" : "已撤销");status.className=`state-${n.state==="approved"?(n.connected?"online":"offline"):n.state}`;
  const m=n.metrics || {};addCell(row,Number.isFinite(m.cpu_percent)&&m.cpu_percent>=0&&m.cpu_percent<=100 ? `${number(m.cpu_percent)}%` : "—");addCell(row,m.memory ? `${bytes(m.memory.used_bytes)} / ${bytes(m.memory.total_bytes)}` : "—");
  const disks=Array.isArray(m.disks)?m.disks.filter(d=>d&&typeof d==="object"):[];const totalDisk=diskSummary(m);const disk=addCell(row,totalDisk?`${bytes(totalDisk.used_bytes)} / ${bytes(totalDisk.total_bytes)}`:"—");disk.title=disks.map(d=>`${d.mount}: ${bytes(d.used_bytes)} / ${bytes(d.total_bytes)}`).join(" · ");
  const networks=Array.isArray(m.networks)?m.networks.filter(n=>n&&typeof n==="object"):[],rx=metricRate(networks,"rx_bytes_per_second"),tx=metricRate(networks,"tx_bytes_per_second");addCell(row,n.connected&&rx!==null&&tx!==null?`${bytes(rx)}/s · ${bytes(tx)}/s`:"—");addCell(row,bytes(m.agent_rss_bytes));addCell(row,n.last_seen?new Date(n.last_seen).toLocaleTimeString():"—");
  const actions=addCell(row,"");actions.className="node-actions";const wrapper=addElement(actions,"div","node-action-buttons");
  if(n.state==="approved"){const configure=document.createElement("button");configure.textContent="配置";configure.className="secondary";configure.addEventListener("click",()=>openConfig(n.node_id));wrapper.append(configure);}
  const remove=document.createElement("button");remove.textContent="删除";remove.className="danger";
  remove.addEventListener("click",()=>openDelete(n.node_id));wrapper.append(remove);renderPanel(n);
}
function deleteNotice(text){$("delete-notice").textContent=text;$("delete-notice").hidden=!text;}
function refreshDelete(){
  const node=state?.nodes.find(n=>n.node_id===deleteNodeId);
  if(!node){if(!deleteBusy&&$("node-delete").open)closeDelete();return;}
  if(deleteNodeName!==node.name){deleteNodeName=node.name;$("delete-name").value="";deleteNotice("");}
  $("delete-device-name").textContent=node.name;
  $("delete-device-id").textContent=`设备 ID：${node.node_id}`;
  $("delete-effect").textContent=node.state==="pending"?"删除此设备的加入申请。":"删除后撤销授权，重新加入需使用新邀请。";
  const matches=$("delete-name").value===node.name;
  $("delete-match").textContent=$("delete-name").value&&!matches?"名称不匹配，请按上方名称输入。":"名称须完全一致，包括大小写。";
  $("confirm-delete").disabled=deleteBusy||!matches;
  $("confirm-delete").textContent=deleteBusy?"正在删除…":"确认删除";
  $("cancel-delete").disabled=deleteBusy;$("delete-name").disabled=deleteBusy;
}
function openDelete(id){
  if(deleteBusy||!state?.nodes.some(n=>n.node_id===id))return;
  deleteNodeId=id;deleteNodeName="";$("delete-name").value="";deleteNotice("");refreshDelete();
  $("node-delete").showModal();$("delete-name").focus();
}
function closeDelete(force=false){if(deleteBusy&&!force)return;$("node-delete").close();}
$("delete-name").addEventListener("input",()=>{deleteNotice("");refreshDelete();});
$("cancel-delete").addEventListener("click",()=>closeDelete());
$("node-delete").addEventListener("cancel",e=>{if(deleteBusy)e.preventDefault();});
$("node-delete").addEventListener("close",()=>{deleteNodeId=null;deleteNodeName="";$("delete-name").value="";deleteNotice("");});
$("node-delete-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const node=state?.nodes.find(n=>n.node_id===deleteNodeId);
  if(deleteBusy||!node||$("delete-name").value!==node.name)return;
  deleteBusy=true;deleteNotice("");refreshDelete();
  try{await api(`/panel/api/nodes/${node.node_id}`,"DELETE");closeDelete(true);notice(`${node.name} 已删除。`);await load(true);}
  catch(error){deleteNotice(error.message);}
  finally{deleteBusy=false;refreshDelete();}
});
let quotaBusy=false, quotaNext=0, quotaDay="";
function renderDetail(retryHistory=false){
  if(page!=="detail"||!state)return;
  const id=location.hash.split("?")[0].split("/")[2],node=state.nodes.find(n=>n.node_id===id&&n.state==="approved");
  const live=resourceHistory.get(id)||[],entry=node?storedHistory.get(id):null;
  renderResourceDetail($("detail-page"),node,mergeResourceHistory(entry?.points||[],live,state.settings?.idle_seconds),{
    historyError:entry?.error,
    onRangeChange:()=>{renderDetail(true);},
  });
  if(!node)return;
  const range=Math.max(DEFAULT_CHART_SECONDS,...[...$("detail-page").querySelectorAll("select[data-chart-key]")].map(s=>Number(s.value)));
  const pending=storedHistory.load(id,range,retryHistory);
  if(pending&&pending!==entry.observed){entry.observed=pending;pending.then(()=>{if(page==="detail"&&location.hash.split("?")[0]===`#/server/${id}`)renderDetail();});}
}
function recordResourceSample(node){
  const previous=resourceHistory.get(node.node_id)?.at(-1)?.time||0;
  recordSample(resourceHistory,node,state.settings?.active_seconds);
  const points=resourceHistory.get(node.node_id),gap=points?.at(-2);
  storedHistory.checkpoint(node.node_id,points?.at(-1),gap&&gap.time>previous&&gap.cpu===null&&gap.memory===null&&Object.keys(gap.networks).length===0?gap:undefined,state.settings?.idle_seconds);
}
function renderQuota(data) {
  $("quota-status").textContent="本网络统计";
  $("quota-day").textContent=`${data.day} · UTC`;
  $("quota-updated").textContent=data.checked_at?`更新于 ${new Date(data.checked_at).toLocaleTimeString("zh-CN",{hour12:false})}`:"尚未取得用量";
  $("quota-message").textContent="";$("quota-message").hidden=true;
  $("quota").replaceChildren();
  for(const item of data.rows) {
    const row=document.createElement("tr"),known=typeof item.value==="number"&&Number.isFinite(item.value)&&item.value>=0;
    const format=value=>item.unit==="bytes"?bytes(value):`${item.unit==="GB-s"?quotaDurationFormatter.format(value):number(value)} ${item.unit}`;
    addCell(row,item.name);addCell(row,known?format(item.value):"—");addCell(row,`${format(item.limit)}${item.period==="day"?"/日":""}`,"muted");
    const ratio=known?item.value/item.limit*100:null,c=addCell(row,ratio===null?"—":`${quotaPercentFormatter.format(ratio)}%`,"quota-percent");
    if(ratio!==null){const meter=document.createElement("div"),fill=document.createElement("span");meter.className=`meter ${usageClass(ratio)}`;fill.style.width=`${Math.min(100,ratio)}%`;meter.append(fill);c.append(meter);}
    $("quota").append(row);
  }
}
async function loadQuota(fresh=false) {
  const now=Date.now(),day=new Date(now).toISOString().slice(0,10);
  if(!hasSession()||page!=="settings"||document.hidden||quotaBusy||(!fresh&&quotaNext>now&&quotaDay===day))return;
  quotaBusy=true;$("quota-status").textContent="正在读取";
  try{const data=await api("/panel/api/quota");quotaNext=data.retry_at;quotaDay=data.day;renderQuota(data);}
  catch{quotaNext=now+300000;quotaDay=day;$("quota-status").textContent="读取失败";$("quota").replaceChildren();$("quota-updated").textContent="尚未取得用量";$("quota-message").textContent="暂时无法读取用量，请稍后重试。";$("quota-message").hidden=false;}
  finally{quotaBusy=false;}
}
function load(fresh=false) { return panelRefresh.load(fresh); }
async function loadState() {
  try {
    const data=await api("/panel/api/state?view=live");state=data;settings(data.settings);$("group").textContent=`监控网络：${data.group}`;$("network-code").textContent=data.group;$("network-device-count").textContent=String(data.nodes.length);
    renderInvitations();
    groupOptions("group-filter",[["all","全部设备"],["ungrouped","未分组"]]);
    groupOptions("overview-group-filter",[["all","全部设备"],["ungrouped","未分组"]]);
    if($("node-config").open){groupOptions("config-group",[["","未分组"]]);if(!data.nodes.some(n=>n.node_id===configNodeId)){closeConfig(true);notice("设备已删除，配置已关闭。",true);}}
    if($("node-delete").open)refreshDelete();
    if($("group-manager").open)renderGroups();
    renderNodes();
    return true;
  }catch(e){if($("group-manager").open)groupNotice(e.message,true);else if($("node-config").open)configNotice(e.message,true);else notice(e.message,true);return false;}
}
function connection(text,online=false){$("connection").textContent=text;$("live-dot").className=online?"online":"";}
function stopLive(){clearTimeout(reconnect);clearInterval(heartbeat);if(socket){const old=socket;socket=null;old.close(1000,"panel not viewing");}connection("实时观看已暂停");}
function connect(){
  if(!hasSession()||document.hidden||!livePage()||socket)return;
  const ws=new WebSocket(`${location.protocol==="https:"?"wss:":"ws:"}//${location.host}/panel/api/live`);socket=ws;connection("正在连接");
  ws.onopen=()=>{if(socket!==ws)return;retry=0;connection("实时连接中",true);heartbeat=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:"heartbeat"}));},30000);load();};
  ws.onmessage=event=>{if(socket!==ws)return;let msg;try{msg=JSON.parse(event.data);}catch{return;}if(msg.type==="settings")settings(msg.settings);else if(msg.type==="metrics"&&state){const n=state.nodes.find(n=>n.node_id===msg.node_id);if(n){n.metrics=msg.metrics;n.last_seen=msg.last_seen;n.connected=true;recordResourceSample(n);renderNode(n);if(page==="detail"&&location.hash.split("?")[0]===`#/server/${n.node_id}`)renderDetail();}}else if(msg.type==="refresh")load(true);else if(msg.type==="access_expired"){lockPanel("access_expired");}};
  ws.onclose=()=>{if(socket!==ws)return;socket=null;clearInterval(heartbeat);connection("连接中断，等待重连");if(!document.hidden&&livePage()){const delay=Math.min(60000,2000*2**Math.min(retry++,5));reconnect=setTimeout(connect,delay+Math.random()*1000);}};
  ws.onerror=()=>{if(socket===ws)connection("暂时无法连接");};
}
$("settings-form").addEventListener("input",()=>{dirty=true;});
$("settings-form").addEventListener("submit",async e=>{e.preventDefault();$("save").disabled=true;try{const s=await api("/panel/api/settings","PUT",inputSettings());dirty=false;settings(s);notice("更新间隔已保存。");await load(true);}catch(e){notice(e.message,true);}finally{$("save").disabled=false;}});
$("refresh").addEventListener("click",()=>{load(true);loadQuota(true);});
function invitationRemaining(invite,now=Date.now()) {
  const seconds=Math.max(0,Math.ceil((invite.expires_at-now)/1000));
  return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`;
}
function joinNotice(text,error=false){$("join-notice").textContent=text;$("join-notice").className=error?"error":"hint";$("join-notice").hidden=!text;}
function renderInvitations() {
  const valid=currentInvitation&&!invitationClosed&&currentInvitation.expires_at>Date.now();
  $("join-command").textContent=currentInvitation?.command||(invitationBusy?"正在生成指令…":"请关闭后重新添加设备。");
  $("join-remaining").textContent=currentInvitation?`剩余 ${invitationRemaining(currentInvitation)}`:"";
  $("add-device").disabled=invitationBusy||!state;
  $("copy-join").disabled=invitationBusy||!valid;
  $("copy-join").textContent=invitationCopied?"已复制":"复制";
  $("check-join").disabled=invitationBusy||invitationChecking||!currentInvitation;
}
async function checkInvitation(manual=false) {
  if(invitationChecking||invitationBusy||!currentInvitation||!$("device-join").open)return;
  const id=currentInvitation.id;
  invitationChecking=true;lastInvitationCheck=Date.now();renderInvitations();
  try {
    const result=await api(`/panel/api/invitations/${id}`);
    if(currentInvitation?.id!==id||!$("device-join").open)return;
    if(result.state==="registered") {
      if(!await load(true))throw new Error("无法读取设备配置，请再次检查。");
      if(currentInvitation?.id!==id||!$("device-join").open)return;
      if(!state.nodes.some(n=>n.node_id===result.node_id&&n.state==="approved"))throw new Error("设备已移除，请重新添加。");
      $("device-join").close();currentInvitation=null;openConfig(result.node_id);
    } else if(result.state==="closed") {
      invitationClosed=true;$("join-status").textContent="指令已失效，请重新添加设备。";
    } else if(manual) $("join-status").textContent="设备尚未请求，请重试指令";
    joinNotice("");
  } catch(error){if($("device-join").open&&currentInvitation?.id===id)joinNotice(error.message,true);}
  finally{invitationChecking=false;renderInvitations();}
}
async function openInvitation() {
  if(invitationBusy||invitationChecking)return;
  invitationCopied=false;joinNotice("");$("join-status").textContent="";$("device-join").showModal();
  if(currentInvitation){await checkInvitation();if(!$("device-join").open)return;}
  invitationBusy=true;renderInvitations();
  try {
    if(!currentInvitation||invitationClosed||currentInvitation.expires_at<=Date.now()){
      const data=await api("/panel/api/invitations","POST");
      const localHTTP=location.protocol==="http:"&&["127.0.0.1","[::1]"].includes(location.hostname);
      currentInvitation={...data,command:`spider-watch configure --server "${data.server}" --join ${data.network}${localHTTP?" --allow-local-http":""}`};
      invitationClosed=false;lastInvitationCheck=Date.now();$("join-status").textContent="";
    }
  }catch(error){joinNotice(error.code==="invitation_not_configured"?"请先配置 INVITATION_SECRET。":error.message,true);}
  finally{invitationBusy=false;renderInvitations();}
}
async function copyInvitation() {
  renderInvitations();
  if(invitationBusy||invitationClosed||!currentInvitation||currentInvitation.expires_at<=Date.now())return;
  try{await navigator.clipboard.writeText(currentInvitation.command);invitationCopied=true;joinNotice("");renderInvitations();}
  catch{joinNotice("复制失败，请选中指令手动复制。",true);}
}
$("add-device").addEventListener("click",openInvitation);
$("copy-join").addEventListener("click",copyInvitation);
$("check-join").addEventListener("click",()=>checkInvitation(true));
$("close-join").addEventListener("click",()=>$("device-join").close());
setInterval(()=>{
  if(document.hidden||!$("device-join").open)return;
  renderInvitations();
  if(currentInvitation&&Date.now()>currentInvitation.expires_at+30000){invitationClosed=true;$("join-status").textContent="指令已失效，请重新添加设备。";}
  // Only this modal polls; countdown itself is local. Stop after expiry/consumption.
  if(currentInvitation&&!invitationClosed&&Date.now()-lastInvitationCheck>=2000)checkInvitation();
},1000);

$("device-search").addEventListener("input",()=>{if(state)renderNodes();});
$("group-filter").addEventListener("change",()=>{if(state)renderNodes();});
$("overview-group-filter").addEventListener("change",()=>{if(state)renderNodes();});
function configNotice(text,error=false){$("config-notice").textContent=text;$("config-notice").className=error?"error":"";$("config-notice").hidden=!text;}
function renderIconPicker(){const picker=$("config-icons");picker.replaceChildren();for(const icon of DEVICE_ICONS){const button=addElement(picker,"button","icon-option");button.type="button";button.dataset.icon=icon.id;button.setAttribute("aria-label",icon.label);button.setAttribute("aria-pressed",String(icon.id===configIcon));button.title=icon.label;addDeviceIcon(button,icon.id);addElement(button,"span","",icon.label);button.addEventListener("click",()=>{if(configBusy)return;configIcon=icon.id;for(const option of picker.querySelectorAll("button"))option.setAttribute("aria-pressed",String(option.dataset.icon===configIcon));});}}
function openConfig(id){if(configBusy)return;const n=state?.nodes.find(n=>n.node_id===id);if(!n||n.state!=="approved")return;configNodeId=id;$("config-auto-update").checked=!!n.auto_update;$("node-update-notice").hidden=true;renderNodeUpdate();configIcon=normalizeDeviceIcon(n.icon);$("config-identity").textContent=`${n.name} · ID ${n.node_id}`;$("config-name").value=n.nickname||"";$("config-name").placeholder=n.host?.hostname||n.name;$("config-agent-version").textContent=`客户端版本：${n.host?.agent_version||"尚未上报"}`;groupOptions("config-group",[["","未分组"]]);$("config-group").value=n.group_id||"";renderIconPicker();configNotice("");$("node-config").showModal();$("config-name").focus();}
function closeConfig(force=false){if(configBusy&&!force)return;if($("node-config").open)$("node-config").close();configNodeId=null;}
$("close-config").addEventListener("click",()=>closeConfig());$("cancel-config").addEventListener("click",()=>closeConfig());$("node-config").addEventListener("close",()=>{configNodeId=null;});$("node-config").addEventListener("cancel",e=>{if(configBusy)e.preventDefault();});
$("node-config-form").addEventListener("submit",async e=>{e.preventDefault();const id=configNodeId;if(!id||configBusy)return;const body={nickname:$("config-name").value,group_id:$("config-group").value||null,icon:normalizeDeviceIcon(configIcon),auto_update:$("config-auto-update").checked};configBusy=true;configNotice("");for(const control of $("node-config-form").querySelectorAll("button,input,select"))control.disabled=true;try{await api(`/panel/api/nodes/${id}`,"PATCH",body);closeConfig(true);notice("设备配置已保存。");await load(true);}catch(error){configNotice(error.message,true);}finally{configBusy=false;for(const control of $("node-config-form").querySelectorAll("button,input,select"))control.disabled=false;}});
function renderNodeUpdate(){ $("check-node-update").hidden=$("config-auto-update").checked; $("check-node-update").disabled=nodeUpdateChecking; }
$("config-auto-update").addEventListener("change",()=>{renderNodeUpdate();$("node-update-notice").hidden=true;});
$("check-node-update").addEventListener("click",async()=>{
  const id=configNodeId;if(!id||nodeUpdateChecking)return;
  nodeUpdateChecking=true;renderNodeUpdate();const message=$("node-update-notice");message.hidden=false;message.textContent="正在检查…";
  try {
    const result=await api(`/panel/api/nodes/${id}/update-check`,"POST");
    if(configNodeId!==id||!$("node-config").open)return;
    message.textContent=result.available===true?`可更新至 ${result.version}，在设备上执行 spider-watch --update。`:result.available===false?"当前已是最新版本。":`可用版本 ${result.version}，设备当前版本未知。`;
  }catch(error){if(configNodeId===id&&$("node-config").open)message.textContent=error.message;}
  finally{nodeUpdateChecking=false;renderNodeUpdate();}
});
function groupNotice(text,error=false){$("group-notice").textContent=text;$("group-notice").className=error?"error":"";$("group-notice").hidden=!text;}
function groupControls(){for(const control of $("group-manager").querySelectorAll("button,input"))control.disabled=groupBusy;}
function renderGroups(){
  const groups=state?.node_groups||[],ids=new Set(groups.map(g=>g.id));
  for(const [id,row] of groupRows)if(!ids.has(id)){row.form.remove();groupRows.delete(id);}
  for(const group of groups){
    let row=groupRows.get(group.id);
    if(!row){
      const form=addElement($("group-list"),"form","group-row"),label=addElement(form,"label","group-name","分组名称"),input=addElement(label,"input");input.maxLength=64;input.required=true;
      const members=addElement(label,"small","group-members"),actions=addElement(form,"div","group-actions"),rename=addElement(actions,"button","secondary","重命名"),remove=addElement(actions,"button","danger","删除");rename.type="submit";remove.type="button";
      form.addEventListener("submit",e=>{e.preventDefault();const name=input.value.trim();if(!name){groupNotice("请填写分组名称。",true);return;}groupOperation(async()=>{await api(`/panel/api/node-groups/${group.id}`,"PUT",{name});input.value=name;input.defaultValue=name;if(await load(true))groupNotice("分组名称已保存。");});});
      remove.addEventListener("click",()=>{const current=state?.node_groups.find(g=>g.id===group.id);if(!current||!confirm(`删除分组「${current.name}」？设备将移至未分组。`))return;groupOperation(async()=>{await api(`/panel/api/node-groups/${group.id}`,"DELETE");if(await load(true))groupNotice("分组已删除。");});});
      row={form,input,members,rename,remove};groupRows.set(group.id,row);
    }
    if(row.input.value===row.input.defaultValue)row.input.value=group.name;row.input.defaultValue=group.name;
    row.input.setAttribute("aria-label",`分组名称 ${group.name}`);row.rename.setAttribute("aria-label",`重命名 ${group.name}`);row.remove.setAttribute("aria-label",`删除分组 ${group.name}`);row.members.textContent=`${state.nodes.filter(n=>n.group_id===group.id).length} 台设备`;$("group-list").append(row.form);
  }
  $("groups-empty").hidden=groups.length>0;groupControls();
}
async function groupOperation(action){if(groupBusy)return;groupBusy=true;groupNotice("");groupControls();try{await action();}catch(error){groupNotice(error.message,true);}finally{groupBusy=false;groupControls();}}
function closeGroups(force=false){if(groupBusy&&!force)return;if($("group-manager").open)$("group-manager").close();}
$("manage-groups").addEventListener("click",()=>{if(!state||groupBusy)return;for(const row of groupRows.values())row.input.value=row.input.defaultValue;$("new-group").value="";groupNotice("");renderGroups();$("group-manager").showModal();$("new-group").focus();});
$("close-groups").addEventListener("click",()=>closeGroups());$("group-manager").addEventListener("cancel",e=>{if(groupBusy)e.preventDefault();});
$("create-group-form").addEventListener("submit",e=>{e.preventDefault();const name=$("new-group").value.trim();if(!name){groupNotice("请填写新分组名称。",true);return;}groupOperation(async()=>{await api("/panel/api/node-groups","POST",{name});$("new-group").value="";if(await load(true))groupNotice("分组已创建。");});});
function livePage(){return page==="overview"||page==="detail";}
function routePage(){const route=location.hash.split("?")[0];if(/^#\/server\/[a-f0-9]{32}$/.test(route))return "detail";if(route==="#/manage"||route==="#/admin"&&!/tab=(?:settings|usage)/.test(location.hash))return "manage";if(route==="#/settings"||route==="#/admin")return "settings";return "overview";}
function showPage(){if(!hasSession())return;const next=routePage();if(next!==page){closeConfig(true);closeGroups(true);closeDelete(true);$("device-join").close();}page=next;for(const id of ["group","live-dot","connection"])$(id).hidden=page!=="overview";for(const name of ["overview","manage","settings","detail"])$(name+"-page").hidden=page!==name;for(const button of document.querySelectorAll("[data-page]")){if(button.dataset.page===(page==="detail"?"overview":page))button.setAttribute("aria-current","page");else button.removeAttribute("aria-current");}if(state)renderNodes();if(livePage())connect();else stopLive();if(page==="detail")renderDetail();load();loadQuota();}
for(const button of document.querySelectorAll("[data-page]"))button.addEventListener("click",()=>{location.hash=`/${button.dataset.page}`;});window.addEventListener("hashchange",showPage);
document.addEventListener("visibilitychange",()=>{if(document.hidden){panelRefresh.invalidate();stopLive();}else if(hasSession()){connect();load();loadQuota();}});window.addEventListener("pagehide",()=>{panelRefresh.invalidate();stopLive();});window.addEventListener("pageshow",event=>{if(event.persisted){panelRefresh.invalidate();if(hasSession()){connect();load();loadQuota();}}else connect();});
// Live metrics arrive over the socket. Low-rate lightweight reconciliation
// keeps offline states/membership accurate without repeatedly scanning history.
setInterval(()=>{if(!document.hidden&&page!=="settings")load();},120000);
setInterval(loadQuota,300000);startSession();


function hasSession() {
  if(authLocked||!session)return false;
  if(session.expires_at<=Date.now()){lockPanel("access_expired");return false;}
  return true;
}
function loginLink() { return "/panel/auth/login"; }
function lockPanel(code="access_required") {
  authLocked=true;session=null;clearTimeout(sessionTimer);stopLive();panelRefresh.invalidate();
  for(const dialog of document.querySelectorAll("dialog[open]"))dialog.close();
  state=undefined;currentInvitation=null;nodeRows.clear();nodePanels.clear();groupRows.clear();resourceHistory.clear();storedHistory.clear();$("detail-page").replaceChildren();
  for(const id of ["nodes","node-panels","quota","group-list"])$(id).replaceChildren();
  $("panel-content").hidden=true;$("login-panel").hidden=false;$("session-user").hidden=true;$("session-user").textContent="";$("logout").hidden=true;$("refresh").disabled=true;
  $("group").textContent="";$("connection").textContent="未登录";notice("");
  const denied=code==="admin_required",missing=code==="access_not_configured",failed=code==="connection_failed";
  $("login-title").textContent=missing?"登录尚未配置":denied?"没有访问权限":failed?"暂时无法验证登录":"登录 SpiderWatch";
  $("login-description").textContent=missing?"请先配置 Access 团队域名、应用 AUD 和管理员邮箱。":denied?"当前 Cloudflare 账户没有此面板的管理权限。":failed?"连接失败，请重试。":code==="access_expired"?"会话已到期，请重新登录。":code==="local_logout"?"本地开发模式，仅演示登录与退出。":"使用 Cloudflare 账户登录后查看和管理设备。";
  $("login-link").textContent=denied?"切换 Cloudflare 账户":failed?"重试":"使用 Cloudflare 登录";
  $("login-link").href=denied?"/cdn-cgi/access/logout":loginLink();$("login-link").hidden=missing;
}
function armSessionExpiry() {
  clearTimeout(sessionTimer);
  if(!hasSession())return;
  sessionTimer=setTimeout(()=>{if(hasSession())armSessionExpiry();},Math.min(2147483647,Math.max(1,session.expires_at-Date.now())));
}
async function startSession() {
  try {
    const identity=await api("/panel/api/session");
    if(identity.authenticated!==true||!Number.isFinite(identity.expires_at)||identity.expires_at<=Date.now())throw new Error("invalid session");
    session=identity;authLocked=false;$("login-panel").hidden=true;$("panel-content").hidden=false;
    $("session-user").textContent=identity.mode==="local"?"本地开发":identity.email;$("session-user").title=$("session-user").textContent;$("session-user").hidden=false;
    $("logout").hidden=false;$("logout").title=identity.mode==="local"?"退出本地预览":"退出 Cloudflare Access 会话（会影响该团队的其他 Access 应用）";$("refresh").disabled=false;
    // Session storage is only a landing-page preference, never authentication.
    let firstEntry=true;
    try { firstEntry=sessionStorage.getItem("spiderwatch-panel-session")!==String(identity.expires_at);sessionStorage.setItem("spiderwatch-panel-session",String(identity.expires_at)); } catch {}
    if(firstEntry)history.replaceState(null,"","/panel/#/");
    armSessionExpiry();showPage();
  } catch { if($("login-title").textContent==="正在验证登录")lockPanel("connection_failed"); }
}
$("logout").addEventListener("click",()=>{try{sessionStorage.removeItem("spiderwatch-panel-session");}catch{}const local=session?.mode==="local";lockPanel(local?"local_logout":"access_required");if(!local)location.assign("/cdn-cgi/access/logout");});
