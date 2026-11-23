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
 last_activity TEXT NOT NULL,
 locator TEXT
)`;
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:JSON_HEADERS});
async function hash(value){const bytes=new TextEncoder().encode(value);const digest=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("")}
function validOwner(value){return typeof value==="string"&&/^[a-f0-9]{64}$/.test(value)}
function validId(value){return typeof value==="string"&&/^[a-f0-9-]{36}$/.test(value)}
async function setup(db){await db.prepare(TABLE).run();const cols=await db.prepare('PRAGMA table_info(search_sessions)').all();if(!(cols.results||[]).some(x=>x.name==='locator'))await db.prepare('ALTER TABLE search_sessions ADD COLUMN locator TEXT').run();await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_search_sessions_locator ON search_sessions(locator)').run();await db.prepare('CREATE TABLE IF NOT EXISTS locator_lookup_limits (ip_hash TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)').run();await db.prepare("CREATE TABLE IF NOT EXISTS app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL)").run();const policy=await db.prepare("SELECT setting_value FROM app_settings WHERE setting_key=?").bind("itinerary_retention_days").first();const days=Math.max(0,Math.min(3650,Number(policy?.setting_value)||0));if(days>0){const cutoff=new Date(Date.now()-days*86400000).toISOString();await db.prepare("DELETE FROM search_sessions WHERE status='completed' AND report_json IS NOT NULL AND updated_at < ?").bind(cutoff).run()}}
const LOCATOR_ALPHABET='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOCATOR_BLOCKLIST=['FUCK','SHIT','CUNT','COCK','DICK','PISS','TITS','TWAT','WANK','ARSE','FART','B1TCH','BITCH','BASTARD','SLUT','WHORE','PORN','RAPE'];
function hasOffensiveLocatorText(value){const normalized=String(value||'').toUpperCase().replace(/0/g,'O').replace(/1/g,'I').replace(/3/g,'E').replace(/4/g,'A').replace(/5/g,'S').replace(/7/g,'T');return LOCATOR_BLOCKLIST.some(word=>normalized.includes(word))}
function makeLocator(){const bytes=crypto.getRandomValues(new Uint8Array(8));let out='';for(let i=0;i<8;i++)out+=LOCATOR_ALPHABET[bytes[i]&31];return out}
async function uniqueLocator(db){for(let i=0;i<64;i++){const value=makeLocator();if(hasOffensiveLocatorText(value))continue;const found=await db.prepare('SELECT 1 AS found FROM search_sessions WHERE locator=?').bind(value).first();if(!found)return value}throw new Error('Could not allocate a suitable unique search locator. Please try again.')}
async function allowLocatorLookup(db,request){const ip=request.headers.get('cf-connecting-ip')||'unknown';const ipHash=await hash(ip),now=Date.now(),windowStart=Math.floor(now/600000)*600000;await db.prepare("INSERT INTO locator_lookup_limits(ip_hash,window_start,attempts) VALUES(?,?,1) ON CONFLICT(ip_hash) DO UPDATE SET window_start=excluded.window_start,attempts=CASE WHEN locator_lookup_limits.window_start=excluded.window_start THEN locator_lookup_limits.attempts+1 ELSE 1 END").bind(ipHash,windowStart).run();const row=await db.prepare("SELECT attempts FROM locator_lookup_limits WHERE ip_hash=?").bind(ipHash).first();return Number(row?.attempts||0)<=10}
async function ownerFrom(body){if(!validOwner(body.owner_token))throw new Error("A valid search owner token is required.");return hash(body.owner_token)}
export async function onRequestGet({request,env}){
 const db=env?.QUOTA_DB;if(!db)return json({error:"Search history is temporarily unavailable."},503);
 try{await setup(db);const url=new URL(request.url),locator=(url.searchParams.get("locator")||"").toUpperCase(),token=url.searchParams.get("owner_token")||"",id=url.searchParams.get("id")||"";
 if(locator){if(!/^[2-9A-HJ-NP-Z]{8}$/.test(locator))return json({error:"Invalid locator."},400);if(!await allowLocatorLookup(db,request))return json({error:"Too many locator attempts. Please wait 10 minutes and try again."},429);const row=await db.prepare("SELECT locator,status,destination,start_date,end_date,report_json,duration_ms,created_at,updated_at FROM search_sessions WHERE locator=? AND status='completed' AND report_json IS NOT NULL").bind(locator).first();if(!row)return json({error:"No completed itinerary was found for that locator."},404);return json({itinerary:{locator:row.locator,destination:row.destination,start_date:row.start_date,end_date:row.end_date,report:parse(row.report_json,null),duration_ms:row.duration_ms,created_at:row.created_at,updated_at:row.updated_at}})}
 if(!validOwner(token))return json({error:"Search history access token is invalid."},401);
 const owner=await hash(token);
 const staleCutoff=new Date(Date.now()-30*60*1000).toISOString();await db.prepare("UPDATE search_sessions SET status='abandoned',updated_at=? WHERE owner_hash=? AND status='in_progress' AND last_activity < ?").bind(new Date().toISOString(),owner,staleCutoff).run();
 if(id){if(!validId(id))return json({error:"Invalid search ID."},400);const row=await db.prepare("SELECT session_id,locator,status,destination,start_date,end_date,input_json,progress_json,report_json,duration_ms,created_at,updated_at,last_activity FROM search_sessions WHERE session_id=? AND owner_hash=?").bind(id,owner).first();if(!row)return json({error:"Saved search not found."},404);return json({session:{...row,input:parse(row.input_json,{}),progress:parse(row.progress_json,{}),report:parse(row.report_json,null)}})}
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
 const existing=await db.prepare("SELECT locator FROM search_sessions WHERE session_id=? AND owner_hash=?").bind(id,owner).first();const locator=existing?.locator||await uniqueLocator(db);
 const destination=String(input.dest||input.destination||"").slice(0,160),startDate=String(input.d1||"").slice(0,10)||null,endDate=String(input.d2||"").slice(0,10)||null,duration=Math.max(0,Math.min(3600000,Number(body.duration_ms)||0));
 await db.prepare(`INSERT INTO search_sessions(session_id,owner_hash,status,destination,start_date,end_date,input_json,progress_json,report_json,duration_ms,created_at,updated_at,last_activity,locator)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
 ON CONFLICT(session_id) DO UPDATE SET status=CASE WHEN search_sessions.status='completed' AND excluded.status!='completed' THEN search_sessions.status ELSE excluded.status END,destination=excluded.destination,start_date=excluded.start_date,end_date=excluded.end_date,input_json=excluded.input_json,progress_json=excluded.progress_json,report_json=COALESCE(excluded.report_json,search_sessions.report_json),duration_ms=MAX(search_sessions.duration_ms,excluded.duration_ms),updated_at=excluded.updated_at,last_activity=excluded.last_activity,locator=COALESCE(search_sessions.locator,excluded.locator)
 WHERE search_sessions.owner_hash=excluded.owner_hash`)
 .bind(id,owner,status,destination,startDate,endDate,inputJson,progressJson,reportJson,duration,now,now,now,locator).run();
 const row=await db.prepare("SELECT owner_hash FROM search_sessions WHERE session_id=?").bind(id).first();if(!row||row.owner_hash!==owner)return json({error:"Unable to save this search session."},403);
 return json({success:true,session_id:id,locator,status,updated_at:now});
 }catch(error){console.error("Search history save failed:",error?.message||error);return json({error:"Unable to save search progress."},500)}
}
export async function onRequestDelete({request,env}){
 const db=env?.QUOTA_DB;if(!db)return json({error:"Search history is temporarily unavailable."},503);
 try{await setup(db);const body=await request.json(),owner=await ownerFrom(body);if(!validId(body.session_id))return json({error:"Invalid search ID."},400);
 const result=await db.prepare("DELETE FROM search_sessions WHERE session_id=? AND owner_hash=?").bind(body.session_id,owner).run();return json({success:true,deleted:Number(result.meta?.changes||0)});
 }catch(error){return json({error:"Unable to delete saved search."},500)}
}
