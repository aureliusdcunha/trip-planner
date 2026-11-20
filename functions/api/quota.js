import { getWorkersAIQuota } from "../lib/ai-quota.js";

export async function onRequestGet({env}){
 const quota=await getWorkersAIQuota(env);
 return new Response(JSON.stringify(quota),{status:quota.error?503:200,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
}
