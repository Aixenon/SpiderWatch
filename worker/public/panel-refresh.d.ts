export function createPanelRefresh(read:()=>Promise<boolean>, options?:{enabled?:()=>boolean;now?:()=>number;reuseMs?:number}):{
  load(fresh?:boolean):Promise<boolean>;
  invalidate():void;
};
