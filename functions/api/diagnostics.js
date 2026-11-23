const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, no-cache, must-revalidate",
  "x-content-type-options": "nosniff"
};

const TABLE = `CREATE TABLE IF NOT EXISTS transaction_logs (
 transaction_id TEXT PRIMARY KEY,
 endpoint TEXT NOT NULL,
 started_at TEXT NOT NULL,
 completed_at TEXT NOT NULL,
 duration_ms INTEGER NOT NULL,
 http_status INTEGER NOT NULL,
 outcome TEXT NOT NULL,
 log_json TEXT NOT NULL
)`;
const SETTINGS_TABLE = `CREATE TABLE IF NOT EXISTS diagnostics_settings (
 setting_key TEXT PRIMARY KEY,
 setting_value TEXT NOT NULL,
 updated_at TEXT NOT NULL
)`;
async function getRetentionDays(db) {
 await db.prepare(SETTINGS_TABLE).run();
 const row=await db.prepare("SELECT setting_value FROM diagnostics_settings WHERE setting_key='retention_days'").first();
 const days=Number.parseInt(row?.setting_value||"7",10);
 return Number.isFinite(days)?Math.min(365,Math.max(1,days)):7;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function onRequestGet({ request, env }) {
  const configured = env?.DIAGNOSTICS_TOKEN;
  if (!configured) return json({ error: "Diagnostics are not configured. Add the DIAGNOSTICS_TOKEN secret to this Cloudflare Pages project." }, 503);

  const authorization = request.headers.get("authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!sameSecret(supplied, configured)) return json({ error: "Invalid diagnostics access token." }, 401);

  const db = env?.QUOTA_DB;
  if (!db) return json({ error: "The QUOTA_DB database binding is unavailable." }, 503);

  try {
    await db.prepare(TABLE).run();
    const retentionDays=await getRetentionDays(db);
    const url = new URL(request.url);
    const id = (url.searchParams.get("id") || "").trim();

    if (id) {
      const row = await db.prepare("SELECT log_json FROM transaction_logs WHERE transaction_id = ? LIMIT 1").bind(id).first();
      if (!row) return json({ error: "Transaction not found. It may have expired after seven days." }, 404);
      let log;
      try { log = JSON.parse(row.log_json); } catch { log = row.log_json; }
      return json({ log, retention_days: retentionDays });
    }

    const idsParam = (url.searchParams.get("ids") || "").trim();
    if (idsParam) {
      const ids = [...new Set(idsParam.split(",").map(value => value.trim()).filter(Boolean))];
      if (!ids.length || ids.length > 100 || ids.some(value => value.length > 160)) {
        return json({ error: "Select between 1 and 100 valid transaction IDs per download." }, 400);
      }
      const placeholders = ids.map(() => "?").join(",");
      const rows = await db.prepare(
        "SELECT log_json FROM transaction_logs WHERE transaction_id IN (" + placeholders + ")"
      ).bind(...ids).all();
      const logs = (rows.results || []).map(row => {
        try { return JSON.parse(row.log_json); } catch { return row.log_json; }
      });
      return json({ logs, requested_count: ids.length, returned_count: logs.length });
    }

    const endpoint = (url.searchParams.get("endpoint") || "").trim();
    const outcome = (url.searchParams.get("outcome") || "").trim();
    const status = (url.searchParams.get("status") || "").trim();
    const search = (url.searchParams.get("q") || "").trim().slice(0, 160);
    const from = (url.searchParams.get("from") || "").trim();
    const to = (url.searchParams.get("to") || "").trim();
    const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);

    const clauses = [];
    const values = [];
    if (endpoint) { clauses.push("endpoint = ?"); values.push(endpoint); }
    if (outcome) { clauses.push("outcome = ?"); values.push(outcome); }
    if (status && /^\d{3}$/.test(status)) { clauses.push("http_status = ?"); values.push(Number(status)); }
    if (from) { clauses.push("completed_at >= ?"); values.push(from + "T00:00:00"); }
    if (to) { clauses.push("completed_at < ?"); values.push(to + "T23:59:59.999"); }
    if (search) {
      clauses.push("(transaction_id LIKE ? OR endpoint LIKE ? OR outcome LIKE ? OR log_json LIKE ?)");
      const term = "%" + search + "%";
      values.push(term, term, term, term);
    }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const countRow = await db.prepare("SELECT COUNT(*) AS total FROM transaction_logs" + where).bind(...values).first();
    const rows = await db.prepare(
      "SELECT transaction_id, endpoint, started_at, completed_at, duration_ms, http_status, outcome FROM transaction_logs" +
      where + " ORDER BY completed_at DESC LIMIT ? OFFSET ?"
    ).bind(...values, limit, offset).all();

    return json({
      transactions: rows.results || [],
      total: Number(countRow?.total || 0),
      limit,
      offset,
      retention_days: retentionDays
    });
  } catch (error) {
    console.error("Diagnostics query failed:", error?.stack || error);
    return json({ error: "Unable to retrieve transaction logs.", detail: String(error?.message || error) }, 500);
  }
}

export async function onRequestPost({ request, env }) {
 const configured=env?.DIAGNOSTICS_TOKEN;
 if(!configured)return json({error:"Diagnostics are not configured."},503);
 const authorization=request.headers.get("authorization")||"";
 const supplied=authorization.startsWith("Bearer ")?authorization.slice(7):"";
 if(!sameSecret(supplied,configured))return json({error:"Invalid diagnostics access token."},401);
 const db=env?.QUOTA_DB;if(!db)return json({error:"The QUOTA_DB database binding is unavailable."},503);
 try{
  await db.prepare(TABLE).run();await db.prepare(SETTINGS_TABLE).run();
  const body=await request.json();
  if(body.action!=="update_retention")return json({error:"Unsupported diagnostics settings action."},400);
  const days=Number(body.retention_days);
  if(!Number.isInteger(days)||days<1||days>365)return json({error:"Retention must be between 1 and 365 days."},400);
  const now=new Date().toISOString();
  await db.prepare("INSERT INTO diagnostics_settings(setting_key,setting_value,updated_at) VALUES('retention_days',?,?) ON CONFLICT(setting_key) DO UPDATE SET setting_value=excluded.setting_value,updated_at=excluded.updated_at").bind(String(days),now).run();
  let deleted=0;
  if(body.delete_before){
   const cutoff=new Date(body.delete_before+"T23:59:59.999Z");
   if(!/^\d{4}-\d{2}-\d{2}$/.test(body.delete_before)||Number.isNaN(cutoff.getTime()))return json({error:"Enter a valid delete-before date."},400);
   const result=await db.prepare("DELETE FROM transaction_logs WHERE completed_at < ?").bind(cutoff.toISOString()).run();
   deleted=Number(result.meta?.changes||0);
  }else{
   const cutoff=new Date(Date.now()-days*86400000).toISOString();
   const result=await db.prepare("DELETE FROM transaction_logs WHERE completed_at < ?").bind(cutoff).run();
   deleted=Number(result.meta?.changes||0);
  }
  return json({success:true,retention_days:days,deleted,updated_at:now});
 }catch(error){
  console.error("Diagnostics settings update failed:",error?.stack||error);
  return json({error:"Unable to update diagnostics settings.",detail:String(error?.message||error)},500);
 }
}
