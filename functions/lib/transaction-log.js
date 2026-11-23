// Per-request transaction audit log. Stored in D1 and expired after seven days.
const TABLE=`CREATE TABLE IF NOT EXISTS transaction_logs (
 transaction_id TEXT PRIMARY KEY,
 endpoint TEXT NOT NULL,
 started_at TEXT NOT NULL,
 completed_at TEXT NOT NULL,
 duration_ms INTEGER NOT NULL,
 http_status INTEGER NOT NULL,
 outcome TEXT NOT NULL,
 log_json TEXT NOT NULL
)`;
const MAX_LOG_CHARS=900000;
function safeValue(value,depth=0){
 if(depth>8)return "[depth-limited]";
 if(value===null||typeof value==="number"||typeof value==="boolean")return value;
 if(typeof value==="string")return value.length>12000?value.slice(0,12000)+"…[field truncated]":value;
 if(Array.isArray(value))return value.slice(0,100).map(v=>safeValue(v,depth+1));
 if(typeof value==="object"){
  const out={};
  for(const [k,v] of Object.entries(value).slice(0,150)){
   if(/api.?key|authorization|token|secret|password|cookie/i.test(k)){out[k]="[REDACTED]";continue}
   out[k]=safeValue(v,depth+1);
  }
  return out;
 }
 return String(value);
}
async function bodyText(response){
 try{return await response.text()}catch(e){return "[response capture failed: "+String(e?.message||e)+"]"}
}
async function persist(env,record){
 const db=env?.QUOTA_DB;if(!db)throw new Error("QUOTA_DB binding unavailable");
 await db.prepare(TABLE).run();
 await db.prepare(`INSERT OR REPLACE INTO transaction_logs
 (transaction_id,endpoint,started_at,completed_at,duration_ms,http_status,outcome,log_json)
 VALUES(?,?,?,?,?,?,?,?)`).bind(record.transaction_id,record.endpoint,record.started_at,record.completed_at,record.duration_ms,record.http_status,record.outcome,JSON.stringify(record)).run();
 await db.prepare("DELETE FROM transaction_logs WHERE completed_at < ?").bind(new Date(Date.now()-7*86400000).toISOString()).run();
}
export async function withTransactionLog(context,endpoint,handler){
 const {request,env}=context;
 const id=crypto.randomUUID();
 const start=Date.now(),startedAt=new Date(start).toISOString();
 let requestData=null;
 try{requestData=await request.clone().text()}catch{}
 const requestRecord={method:request.method,url:new URL(request.url).pathname,headers:{contentType:request.headers.get("content-type"),userAgent:request.headers.get("user-agent")},body:requestData};
 if(requestRecord.body){
  try{requestRecord.body=safeValue(JSON.parse(requestRecord.body))}
  catch{requestRecord.body=requestRecord.body.slice(0,20000)}
 }
 let response,handlerError=null;
 try{response=await handler()}catch(error){handlerError={name:error?.name||"Error",message:String(error?.message||error),stack:String(error?.stack||"").slice(0,5000)};response=new Response(JSON.stringify({error:"Internal server error.",transactionId:id}),{status:500,headers:{"content-type":"application/json"}})}
 const status=response.status;
 const cloned=response.clone();
 const capture=(async()=>{
  const raw=await bodyText(cloned);
  let responseBody=raw;
  try{responseBody=safeValue(JSON.parse(raw))}catch{}
  const completedAt=new Date().toISOString();
  let log={transaction_id:id,endpoint,started_at:startedAt,completed_at:completedAt,duration_ms:Date.now()-start,http_status:status,outcome:handlerError?"exception":status>=500?"server_error":status>=400?"client_error":"success",request:requestRecord,response:responseBody,error:handlerError};
  let serialized=JSON.stringify(log);
  if(serialized.length>MAX_LOG_CHARS){log={...log,request:{...requestRecord,body:"[omitted: transaction log exceeded 900KB]"},response:"[omitted: transaction log exceeded 900KB]",truncated:true};serialized=JSON.stringify(log)}
  try{await persist(env,log)}catch(error){console.error("Transaction log persistence failed",id,error?.message||error)}
 })();
 const waitUntil=context.waitUntil;
 if(typeof waitUntil==="function")waitUntil.call(context,capture);
 else await capture;
 const headers=new Headers(response.headers);headers.set("x-transaction-id",id);
 return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
}
