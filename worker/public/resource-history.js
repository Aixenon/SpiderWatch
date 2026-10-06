// One on-demand request shared by all charts; never poll history on a timer.
export function createHistoryCache(fetchHistory, limit = 3) {
  const entries = new Map();
  const isGap=point=>point.cpu===null&&point.memory===null&&Object.keys(point.networks||{}).length===0;
  function compact(entry,points,to) {
    const samples=new Map(),gaps=new Map(),step=entry.resolution_seconds*1000;
    for(const point of points){
      if(!Number.isFinite(point.time)||point.time<to-604800000)continue;
      const bucket=Math.floor((point.time-entry.origin)/step),target=isGap(point)?gaps:samples;
      if(!target.has(bucket)||point.time>=target.get(bucket).time)target.set(bucket,{...point,interval_seconds:Math.max(point.interval_seconds||entry.interval_seconds,entry.resolution_seconds)});
    }
    // Gaps have their own bounded budget; pauses cannot evict valid older data.
    const values=[...samples.values()].sort((a,b)=>a.time-b.time).slice(-1008);
    const boundaries=[...gaps.values()].sort((a,b)=>a.time-b.time).filter(p=>p.time>=Math.min(values[0]?.time??to,to-entry.range*1000)).slice(-1008);
    return [...values,...boundaries].sort((a,b)=>a.time-b.time);
  }
  function get(id) {
    let entry=entries.get(id);
    if(!entry)entry={points:[],range:0,wanted:0,attempted:0,pending:null,error:"",stale:false,interval_seconds:600,resolution_seconds:1,origin:0};
    entries.delete(id);entries.set(id,entry);
    while(entries.size>limit)entries.delete(entries.keys().next().value);
    return entry;
  }
  function load(id,seconds,retry=false) {
    const entry=get(id);
    entry.wanted=Math.max(entry.wanted,seconds);
    // Refresh once on returning after a pause that the live buffer cannot cover.
    if(entry.stale){entry.attempted=0;entry.stale=false;}
    if(retry&&entry.error){entry.attempted=entry.range;entry.error="";}
    if(entry.pending)return entry.pending;
    if(entry.attempted>=entry.wanted)return null;
    entry.pending=(async()=>{
      while(entries.get(id)===entry&&entry.attempted<entry.wanted){
        const range=entry.wanted;entry.attempted=range;
        try{
          const result=await fetchHistory(id,range);
          if(entries.get(id)!==entry)return;
          // Retain live checkpoints received while the request was in flight.
          entry.interval_seconds=result.interval_seconds||600;
          entry.resolution_seconds=result.resolution_seconds||Math.ceil(range/1007);
          entry.origin=result.from??result.to-range*1000;
          const fallback=Math.max(entry.interval_seconds,entry.resolution_seconds);
          const points=new Map(result.points.map(p=>[p.time,{...p,interval_seconds:p.interval_seconds||fallback}]));
          for(const point of entry.points)if(point.time>result.to||isGap(point))points.set(point.time,point);
          entry.range=range;
          entry.points=compact(entry,[...points.values()].filter(p=>p.time>=result.to-range*1000),Math.max(result.to,...points.keys()));
          entry.error="";
        }catch{entry.error="历史数据读取失败，请重新选择时间范围重试。";break;}
      }
    })().finally(()=>{entry.pending=null;});
    return entry.pending;
  }
  function checkpoint(id,point,gap,idleSeconds) {
    const entry=entries.get(id);
    if(!entry?.range||!point)return;
    const cadence=Math.max(idleSeconds||entry.interval_seconds,entry.resolution_seconds);
    const last=entry.points.at(-1);
    if(last&&point.time-last.time>Math.max(last.interval_seconds||entry.interval_seconds,cadence)*2500)entry.stale=true;
    const preserveGap=gap&&(!last||gap.time>last.time);
    if(preserveGap)entry.points.push(gap);
    // Keep long views current locally as the dense live buffer rotates.
    if(preserveGap||!last||point.time-last.time>=cadence*1000){entry.points.push({...point,interval_seconds:cadence});entry.points=compact(entry,entry.points,point.time);}
  }
  return {get,load,checkpoint,clear:()=>entries.clear(),delete:id=>entries.delete(id),keys:()=>entries.keys()};
}
