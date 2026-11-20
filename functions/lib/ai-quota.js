// Shared, persistent Workers AI daily neuron guard for TripPlanner.
// Reservations are conservative estimates based on GLM-4.7-Flash published neuron rates.
export const DAILY_NEURON_LIMIT = 9900;
const MODEL = "@cf/zai-org/glm-4.7-flash";
const INPUT_NEURONS_PER_TOKEN = 5500 / 1000000;
const OUTPUT_NEURONS_PER_TOKEN = 36400 / 1000000;

function utcDate(){ return new Date().toISOString().slice(0,10); }

export function estimateNeuronReservation(input, maxOutputTokens=1000){
  const serialized = typeof input === "string" ? input : JSON.stringify(input ?? "");
  // Three characters per input token is intentionally conservative.
  const estimatedInputTokens = Math.ceil(serialized.length / 3);
  const raw = estimatedInputTokens * INPUT_NEURONS_PER_TOKEN
    + Math.max(0, Number(maxOutputTokens)||0) * OUTPUT_NEURONS_PER_TOKEN;
  return Math.max(1, Math.ceil(raw * 1.2));
}

async function ensureTable(db){
  await db.prepare(`CREATE TABLE IF NOT EXISTS ai_daily_usage (
    usage_date TEXT PRIMARY KEY,
    reserved_neurons INTEGER NOT NULL DEFAULT 0,
    request_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  )`).run();
}

export async function reserveWorkersAINeurons(env, input, maxOutputTokens=1000){
  const db=env?.QUOTA_DB;
  if(!db) return {allowed:false, reason:"quota_database_unavailable"};
  const reservation=estimateNeuronReservation(input,maxOutputTokens);
  const date=utcDate(), now=new Date().toISOString();
  try{
    await ensureTable(db);
    const row=await db.prepare(`INSERT INTO ai_daily_usage
      (usage_date,reserved_neurons,request_count,updated_at)
      VALUES(?,?,1,?)
      ON CONFLICT(usage_date) DO UPDATE SET
        reserved_neurons=ai_daily_usage.reserved_neurons+excluded.reserved_neurons,
        request_count=ai_daily_usage.request_count+1,
        updated_at=excluded.updated_at
      WHERE ai_daily_usage.reserved_neurons+excluded.reserved_neurons<=?
      RETURNING reserved_neurons,request_count`)
      .bind(date,reservation,now,DAILY_NEURON_LIMIT).first();
    if(!row) return {allowed:false,reason:"daily_limit_reached",limit:DAILY_NEURON_LIMIT,reservation};
    return {allowed:true,reservation,used:Number(row.reserved_neurons)||0,requests:Number(row.request_count)||0,limit:DAILY_NEURON_LIMIT,date};
  }catch(error){
    console.error("Workers AI quota reservation failed:",error?.message||error);
    return {allowed:false,reason:"quota_database_error"};
  }
}

export async function getWorkersAIQuota(env){
  const db=env?.QUOTA_DB;
  if(!db) return {configured:false,limit:DAILY_NEURON_LIMIT,used:0,remaining:0,date:utcDate()};
  const date=utcDate();
  try{
    await ensureTable(db);
    const row=await db.prepare("SELECT reserved_neurons,request_count,updated_at FROM ai_daily_usage WHERE usage_date=?").bind(date).first();
    const used=Number(row?.reserved_neurons)||0;
    return {configured:true,limit:DAILY_NEURON_LIMIT,used,remaining:Math.max(0,DAILY_NEURON_LIMIT-used),requests:Number(row?.request_count)||0,date,updatedAt:row?.updated_at||null};
  }catch(error){
    console.error("Workers AI quota status failed:",error?.message||error);
    return {configured:false,error:"quota_status_unavailable",limit:DAILY_NEURON_LIMIT,date};
  }
}

export async function runWorkersAIWithQuota(env, model, input, options, maxOutputTokens=1000){
  if(!env?.AI) return {allowed:false,reason:"workers_ai_unavailable"};
  const quota=await reserveWorkersAINeurons(env,input,maxOutputTokens);
  if(!quota.allowed) return {allowed:false,reason:quota.reason,quota};
  try{
    const result=await env.AI.run(model,{...options});
    return {allowed:true,result,quota};
  }catch(error){
    // Keep the reservation: a failed response may still have consumed inference resources.
    throw error;
  }
}
