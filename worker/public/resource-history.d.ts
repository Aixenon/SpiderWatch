import type {ResourcePoint} from "./resource-charts.js";
export type HistoryEntry={points:ResourcePoint[];range:number;wanted:number;attempted:number;pending:Promise<void>|null;error:string;stale:boolean;interval_seconds:number;resolution_seconds:number;origin:number};
export function createHistoryCache(fetchHistory:(id:string,seconds:number)=>Promise<{points:ResourcePoint[];to:number;from?:number;interval_seconds?:number;resolution_seconds?:number}>,limit?:number):{
  get(id:string):HistoryEntry;
  load(id:string,seconds:number,retry?:boolean):Promise<void>|null;
  checkpoint(id:string,point?:ResourcePoint,gap?:ResourcePoint,idleSeconds?:number):void;
  clear():void;
  delete(id:string):boolean;
  keys():IterableIterator<string>;
};
