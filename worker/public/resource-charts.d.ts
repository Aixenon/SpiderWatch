export const HISTORY_POINTS: number;
export const DEFAULT_CHART_SECONDS: number;
export const CHART_RANGES: {seconds:number;label:string}[];
export type ChartPoint = {time:number;[key:string]:number|null|undefined};
export type ResourcePoint = {time:number;interval_seconds?:number;cpu:number|null;memory:number|null;networks:Record<string,{rx:number|null;tx:number|null}>};
export function chartGeometry(points: ChartPoint[],keys:string[],maximum?:number,windowMs?:number,endTime?:number):{series:{key:string;path:string;markers:{x:number;y:number}[]}[];maximum:number;ticks:{value:number;y:number}[];first:number;last:number;count:number};
export function mergeResourceHistory(stored:ResourcePoint[],live:ResourcePoint[],idleSeconds?:number):ResourcePoint[];
export function recordSample(history:Map<string,ResourcePoint[]>,node:{node_id:string;connected:boolean;last_seen?:number;metrics?:Record<string,unknown>},expectedSeconds?:number):void;
