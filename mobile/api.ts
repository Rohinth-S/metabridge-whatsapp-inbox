export type ApiConfig={baseUrl:string; token?:string};
export async function request<T>(config:ApiConfig,path:string,init:RequestInit={}):Promise<T>{const res=await fetch(`${config.baseUrl}${path}`,{...init,headers:{"content-type":"application/json",...(config.token?{authorization:`Bearer ${config.token}`}:{}),...(init.headers??{})}}); if(!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`); return res.json() as Promise<T>;}
export function listMessages(config:ApiConfig){return request<Array<Record<string,unknown>>>(config,"/inbox");}
