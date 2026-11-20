// Exact-input cache for completed TripPlanner reports.
// Flight options are deliberately excluded; they are researched afresh on every cache hit.
const TABLE=`CREATE TABLE IF NOT EXISTS trip_report_cache (
 cache_key TEXT PRIMARY KEY,
 input_json TEXT NOT NULL,
 report_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
)`;
async function ready(db){await db.prepare(TABLE).run()}
export async function makeTripCacheKey(input){
 const bytes=new TextEncoder().encode(JSON.stringify(input));
 const digest=await crypto.subtle.digest("SHA-256",bytes);
 return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
}
export async function readTripReportCache(env,key){
 if(!env?.QUOTA_DB)return null;
 try{
  await ready(env.QUOTA_DB);
  const row=await env.QUOTA_DB.prepare("SELECT report_json,created_at FROM trip_report_cache WHERE cache_key=?").bind(key).first();
  if(!row?.report_json)return null;
  const report=JSON.parse(row.report_json);
  if(!report||typeof report!=="object"||Array.isArray(report))return null;
  return {report,createdAt:row.created_at||null};
 }catch(error){console.error("Trip report cache read failed:",error?.message||error);return null}
}
export async function writeTripReportCache(env,key,input,report){
 if(!env?.QUOTA_DB)return false;
 try{
  const inputJson=JSON.stringify(input),reportJson=JSON.stringify(report);
  // Leave headroom below D1's per-value/row limits; an unusually large trip still completes uncached.
  if(reportJson.length>1500000)return false;
  await ready(env.QUOTA_DB);
  const now=new Date().toISOString();
  await env.QUOTA_DB.prepare(`INSERT INTO trip_report_cache(cache_key,input_json,report_json,created_at,updated_at)
   VALUES(?,?,?,?,?)
   ON CONFLICT(cache_key) DO UPDATE SET input_json=excluded.input_json,report_json=excluded.report_json,updated_at=excluded.updated_at`)
   .bind(key,inputJson,reportJson,now,now).run();
  return true;
 }catch(error){console.error("Trip report cache write failed:",error?.message||error);return false}
}
