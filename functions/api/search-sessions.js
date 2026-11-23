const JSON_HEADERS={"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
const TABLE=`CREATE TABLE IF NOT EXISTS search_sessions (
 session_id TEXT PRIMARY KEY,
 owner_hash TEXT NOT NULL,
 status TEXT NOT NULL,
 destination TEXT NOT NULL DEFAULT '',
 start_date TEXT,
 end_date TEXT,
 input_json TEXT NOT NULL,
 progress_json TEXT NOT NULL DEFAULT '{}',
 report_json TEXT,
 duration_ms INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 last_activity TEXT NOT NULL
)`;
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:JSON_HEADERS});
async function hash(value){const bytes=new TextEncoder().encode(value);const digest=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("")}
function validOwner(value){return typeof value==="string"&&/^[a-f0-9]{64}$/.test(value)}
function validId(value){return typeof value==="string"&&/^[a-f0-9-]{36}$/.test(value)}
async function setup(db){await db.prepare(TABLE).run()}
async function ownerFrom(body){if(!validOwner(body.owner_token))throw new Error("A valid search owner token is required.");return hash(body.owner_token)}
export async function onRequestGet({request,env}){
 const db=env?.QUOTA_DB;if(!db)return json({error:"Search history is temporarily unavailable."},503);
 try{await setup(db);const url=new URL(request.url),token=url.searchParams.get("owner_token")||"",id=url.searchParams.get("id")||"";
 if(!validOwner(token))return json({error:"Search history access token is invalid."},401);
 const owner=await hash(token);
 if(id){if(!validId(id))return json({error:"Invalid search ID."},400);const row=await db.prepare("SELECT session_id,status,destination,start_date,end_date,input_json,progress_json,report_json,duration_ms,created_at,updated_at,last_activity FROM search_sessions WHERE session_id=? AND owner_hash=?").bind(id,owner).first();if(!row)return json({error:"Saved search not found."},404);return json({session:{...row,input:parse(row.input_json,{}),progress:parse(row.progress_json,{}),report:parse(row.report_json,null)}})}
 const rows=await db.prepare("SELECT session_id,status,destination,start_date,end_date,duration_ms,created_at,updated_at,last_activity,progress_json,CASE WHEN report_json IS NULL THEN 0 ELSE 1 END AS has_report FROM search_sessions WHERE owner_hash=? ORDER BY last_activity DESC LIMIT 50").bind(owner).all();
 return json({sessions:(rows.results||[]).map(row=>({...row,progress:parse(row.progress_json,{})}))});
 }catch(error){console.error("Search history read failed:",error?.message||error);return json({error:"Unable to retrieve saved searches."},500)}
}
function parse(value,fallback){try{return value?JSON.parse(value):fallback}catch{return fallback}}
export async function onRequestPost({request,env}){
 const db=env?.QUOTA_DB;if(!db)return json({error:"Search history is temporarily unavailable."},503);
 try{await setup(db);const body=await request.json(),owner=await ownerFrom(body),id=body.session_id;
 if(!validId(id))return json({error:"Invalid search ID."},400);
 const input=body.input&&typeof body.input==="object"?body.input:{};
 const progress=body.progress&&typeof body.progress==="object"?body.progress:{};
 const report=body.report&&typeof body.report==="object"?body.report:null;
 const inputJson=JSON.stringify(input),progressJson=JSON.stringify(progress),reportJson=report?JSON.stringify(report):null;
 if(inputJson.length>30000||progressJson.length>30000||(reportJson&&reportJson.length>1400000))return json({error:"Saved search data exceeds the permitted size."},413);
 const now=new Date().toISOString(),status=["in_progress","abandoned","completed","resumable","failed"].includes(body.status)?body.status:"in_progress";
 const destination=String(input.dest||input.destination||"").slice(0,160),startDate=String(input.d1||"").slice(0,10)||null,endDate=String(input.d2||"").slice(0,10)||null,duration=Math.max(0,Math.min(3600000,Number(body.duration_ms)||0));
 await db.prepare(`INSERT INTO search_sessions(session_id,owner_hash,status,destination,start_date,end_date,input_json,progress_json,report_json,duration_ms,created_at,updated_at,last_activity)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(session_id) DO UPDATE SET status=excluded.status,destination=excluded.destination,start_date=excluded.start_date,end_date=excluded.end_date,input_json=excluded.input_json,progress_json=excluded.progress_json,report_json=COALESCE(excluded.report_json,search_sessions.report_json),duration_ms=MAX(search_sessions.duration_ms,excluded.duration_ms),updated_at=excluded.updated_at,last_activity=excluded.last_activity
 WHERE search_sessions.owner_hash=excluded.owner_hash`)
 .bind(id,owner,status,destination,startDate,endDate,inputJson,progressJson,reportJson,duration,now,now,now).run();
 const row=await db.prepare("SELECT owner_hash FROM search_sessions WHERE session_id=?").bind(id).first();if(!row||row.owner_hash!==owner)return json({error:"Unable to save this search session."},403);
 return json({success:true,session_id:id,status,updated_at:now});
 }catch(error){console.error("Search history save failed:",error?.message||error);return json({error:"Unable to save search progress."},500)}
}
export async function onRequestDelete({request,env}){
 const db=env?.QUOTA_DB;if(!db)return json({error:"Search history is temporarily unavailable."},503);
 try{await setup(db);const body=await request.json(),owner=await ownerFrom(body);if(!validId(body.session_id))return json({error:"Invalid search ID."},400);
 const result=await db.prepare("DELETE FROM search_sessions WHERE session_id=? AND owner_hash=?").bind(body.session_id,owner).run();return json({success:true,deleted:Number(result.meta?.changes||0)});
 }catch(error){return json({error:"Unable to delete saved search."},500)}
}
