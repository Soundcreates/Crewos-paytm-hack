export interface BackgroundJob { id:string; org_id:string; kind:string; attempts:number; }
export function enqueueJob(orgId:string,kind:string,payload:unknown,dedupeKey?:string):Promise<{id:string;status:string;result?:string;error?:string}>;
export function registerJobHandler(kind:string,handler:(payload:Record<string,unknown>,job:BackgroundJob)=>Promise<unknown>):void;
