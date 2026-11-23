import { withTransactionLog } from "../lib/transaction-log.js";
import { getWorkersAIQuota } from "../lib/ai-quota.js";

async function handleQuotaGet({env}){
 const quota=await getWorkersAIQuota(env);
 return new Response(JSON.stringify(quota),{status:quota.error?503:200,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
}

export async function onRequestGet(context){return withTransactionLog(context,"quota",()=>handleQuotaGet(context));}
