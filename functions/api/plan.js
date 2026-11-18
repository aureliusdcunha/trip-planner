// Cloudflare Pages Function: POST /api/plan
// Parallel travel-research specialists orchestrated by one streamed request.
// Each specialist returns a bounded JSON object; route -> research -> day planners.
const encoder=new TextEncoder();
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const clip=(v,n)=>String(v??"").replace(/[\r\n]+/g," ").slice(0,n);
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const str={type:"string"},num={type:"number"};
const obj=(properties,required=Object.keys(properties))=>({type:"object",properties,required});
const arr=items=>({type:"array",items});
const schemas={
 route:obj({overview:str,best_time:str,destination_currency:str,currency_code:str,local_context:str,route_summary:str,areas:arr(obj({name:str,nights:str,why:str}))}),
 flights:obj({getting_there:str,flight_options:arr(obj({route:str,airlines:str,duration:str,price_estimate:num,booking_advice:str}))}),
 transport:obj({internal_transport:arr(obj({mode:str,route:str,duration:str,price_estimate:num,pros:str,booking_advice:str}))}),
 stay:obj({hotel_options:arr(obj({tier:str,name:str,location:str,price_per_night:num,room_notes:str,why:str,booking_url:str}))}),
 attractions:obj({highlights:arr(obj({name:str,area:str,category:str,duration:str,price_estimate:num,why_visit:str,practical_tip:str,booking_url:str}))}),
 dining:obj({dining:arr(obj({name:str,area:str,cuisine:str,signature:str,price_per_person:num,why_visit:str}))}),
 guide:obj({
  practical:obj({entry_requirements:str,visa:str,weather:str,connectivity:str,health_safety:str,money:str,local_etiquette:str,packing:str}),
  budget:obj({currency:str,home_currency:str,exchange_rate_to_home:num,international_flight_per_person:num,local_transport_total:num,hotel_per_room_per_night:num,activity_per_person_per_day:num,food_per_person_per_day:num,shopping_per_person:num,contingency_percent:num,assumptions:arr(str)}),
  tips:arr(str),caveats:arr(str)
 }),
 day:obj({days:arr(obj({date:str,base:str,title:str,pace:str,activities:arr(obj({time:str,name:str,category:str,description:str,duration:str,transport:str,cost_estimate:num,booking_url:str,child_friendly:str})),meals:arr(obj({meal:str,suggestion:str,price_estimate:num})),overnight:str,day_estimate:num}))})
};
function validDate(s){if(!DATE.test(s))return false;const d=new Date(s+"T00:00:00Z");return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===s}
function nightsOf(v){const m=String(v??"").match(/\d+/);return m?Math.max(0,Number(m[0])):0}
function normaliseAreas(areas,tripNights,maxBases){
 let result=(Array.isArray(areas)?areas:[]).filter(a=>a&&clip(a.name,100)).slice(0,maxBases);
 if(!result.length)throw new Error("The route planner did not return any overnight bases.");
 if(tripNights===0)return result.slice(0,1).map(a=>({...a,nights:"0 nights"}));
 if(result.length>tripNights)result=result.slice(0,tripNights);
 const raw=result.map(a=>nightsOf(a.nights));let assigned=raw.slice();
 if(raw.reduce((a,b)=>a+b,0)!==tripNights||raw.some(v=>v<1)){
  const base=Math.floor(tripNights/result.length),extra=tripNights%result.length;
  assigned=result.map((_,i)=>base+(i<extra?1:0));
 }
 return result.map((a,i)=>({...a,nights:assigned[i]+" "+(assigned[i]===1?"night":"nights")}));
}
function collectSources(value,out){
 if(!value||typeof value!=="object")return;
 if(Array.isArray(value)){for(const item of value)collectSources(item,out);return}
 const url=value.url||value.uri;
 const title=value.title||value.name;
 if(typeof url==="string"&&/^https:\/\//i.test(url)){
  out.push({title:clip(title||new URL(url).hostname,180),url});
 }
 for(const [k,v] of Object.entries(value))if(k!=="url"&&k!=="uri")collectSources(v,out);
}
function sourceUnique(sources){
 const seen=new Set();return sources.filter(s=>{if(!s?.url||seen.has(s.url))return false;seen.add(s.url);return true}).slice(0,60);
}
function extractJsonText(value){
 if(typeof value==="string")return value;
 if(Array.isArray(value))return value.map(extractJsonText).join("");
 if(value&&typeof value==="object"){
  if(typeof value.text==="string")return value.text;
  if(Array.isArray(value.content))return value.content.map(extractJsonText).join("");
  if(Array.isArray(value.parts))return value.parts.map(extractJsonText).join("");
 }
 return "";
}
function validateAgent(kind,data,ctx){
 if(!data||typeof data!=="object")return "The "+kind+" researcher returned no structured result.";
 if(kind==="route"&&(!Array.isArray(data.areas)||!data.areas.length))return "The route researcher did not identify overnight bases.";
 if(kind==="flights"&&!Array.isArray(data.flight_options))return "The flight researcher returned an incomplete result.";
 if(kind==="transport"&&!Array.isArray(data.internal_transport))return "The transport researcher returned an incomplete result.";
 if(kind==="stay"&&(!Array.isArray(data.hotel_options)||!data.hotel_options.length))return "The accommodation researcher returned no hotel options.";
 if(kind==="attractions"&&!Array.isArray(data.highlights))return "The attraction researcher returned no experiences.";
 if(kind==="dining"&&!Array.isArray(data.dining))return "The dining researcher returned no recommendations.";
 if(kind==="guide"){
  const keys=["exchange_rate_to_home","international_flight_per_person","local_transport_total","hotel_per_room_per_night","activity_per_person_per_day","food_per_person_per_day","shopping_per_person","contingency_percent"];
  if(!data.practical||!data.budget||keys.some(k=>!Number.isFinite(data.budget[k])||data.budget[k]<0)||!Array.isArray(data.tips)||!Array.isArray(data.caveats))return "The practical/budget researcher returned incomplete data.";
 }
 if(kind==="day"){
  if(!Array.isArray(data.days)||data.days.length!==1)return "The day planner must return exactly one day.";
  const d=data.days[0];if(d.date!==ctx.date||!Array.isArray(d.activities)||d.activities.length<2||!Array.isArray(d.meals))return "The daily plan is missing activities, meals or the requested date.";
 }
 return null;
}
function promptFor(kind,ctx){
 const t=ctx.trip;
 const party="Travellers: "+t.pax+" total ("+t.adults+" adults, "+(t.pax-t.adults)+" children). Budget style: "+t.bud+". Departing from: "+t.from+". Home currency: "+t.cur+". Interests: "+(t.int||"balanced sightseeing, food and culture")+".";
 const searchInstruction=ctx.useSearch?"You have Google Search available. Actively run at least one focused search for this exact assignment and ground recommendations in the returned sources; do not rely only on model memory. Prefer official or reputable primary sources.":"Live Google Search was not enabled. Use established knowledge and label prices, schedules and availability as indicative; do not imply you checked live sources.";
 const common="Destination: "+t.dest+". Dates: "+t.d1+" to "+t.d2+" inclusive. "+party+" "+searchInstruction+" Use accurate real places. Do not invent live availability, exact fares, flight schedules or opening hours. All prices must be numeric estimates in destination local currency. Prefer official tourism, attraction, hotel, transport and venue sources. If uncertain, say so rather than inventing.";
 if(kind==="route")return "You are the ROUTE ARCHITECT for a travel-planning team. Your only task is choosing sensible overnight bases and the route between them. "+common+" Return "+ctx.maxBases+" or fewer bases. The number of nights must add up to exactly "+ctx.nights+"; for a day trip, return one base with 0 nights. Avoid unnecessary backtracking and group geographically. For each base return its name, nights as e.g. '3 nights', and a short reason. Also return overview, best_time, destination_currency, currency_code, local_context and route_summary. Do not return hotels, activities, meals, flights or budget. Keep concise.";
 if(kind==="flights")return "You are the FLIGHT SPECIALIST. Research only inbound/outbound route options. "+common+" From "+t.from+" to "+t.dest+". Return 2-3 plausible airline/route options, typical journey duration, indicative round-trip fare per traveller in destination currency, and booking advice. Do not invent flight numbers or exact schedules. Include getting_there as a concise arrival/departure note. No hotels or day plans.";
 if(kind==="transport")return "You are the LOCAL TRANSPORT SPECIALIST. Research only realistic transfer options for this route. "+common+" Route bases: "+ctx.areas.map(a=>a.name+" ("+a.nights+")").join(" → ")+". Return 2-4 useful transfers including mode, route, indicative total or route fare in destination currency, duration and pros. Do not add daily attractions or flights.";
 if(kind==="stay")return "You are the ACCOMMODATION SPECIALIST for "+ctx.area.name+". Research lodging for this base only. "+common+" Suggested stay: "+ctx.area.nights+". Party composition: "+t.pax+" travellers, "+t.adults+" adults and "+(t.pax-t.adults)+" children. Return 2-3 distinct hotel options appropriate to the budget style, with actual property names, neighbourhood, indicative nightly room price in local currency, room notes and why suitable. Include booking_url only if the search confirms an official hotel or trusted booking page; otherwise empty string. Never claim rooms are available. Do not research other bases.";
 if(kind==="attractions")return "You are the ATTRACTIONS SPECIALIST for "+ctx.area.name+". Research only real attractions, cultural experiences and activities in or near this base. "+common+" Return 3-5 high-value options with area, category, visit duration, numeric per-person price (0 for free), why visit, practical tip and official booking_url only when verified. Tailor family suitability to children if present. No hotels, dining or day-by-day schedule.";
 if(kind==="dining")return "You are the DINING SPECIALIST for "+ctx.area.name+". Research only restaurants, food markets, signature local dishes and authentic dining experiences in or near this base. "+common+" Return 2-3 specific real options with cuisine, signature, indicative price per person in destination currency and why visit. Avoid inventing addresses or reservation links. Do not plan activities or hotels.";
 if(kind==="guide")return "You are the TRAVEL PRACTICALITIES AND BUDGET SPECIALIST. Research passport-dependent entry guidance, weather for travel dates, connectivity, health/safety, money, etiquette and packing. "+common+" Home currency is "+t.cur+". Return a complete practical guide. For numeric budget: international_flight_per_person = round-trip fare per traveller; local_transport_total = whole-party transport total; hotel_per_room_per_night = typical nightly rate for this budget tier; activity_per_person_per_day and food_per_person_per_day = per-person daily averages; shopping_per_person = per-person whole-trip allowance; contingency_percent 10-20; exchange_rate_to_home = units of home currency for one destination currency unit if reasonably known, else 0. Provide 5-7 tips and 2-4 caveats. Do not calculate a grand total. Never assert visa eligibility without nationality.";
 if(kind==="day"){
  const list=ctx.highlights.length?ctx.highlights.map(h=>h.name+" — "+h.why_visit).join("; "):"Choose well-known, relevant local experiences.";
  return "You are the DAY PLANNER. Create exactly one realistic day for "+ctx.date+" in "+ctx.base+". "+common+" Day number "+ctx.dayNumber+" of "+t.days+"; "+(ctx.dayNumber===1?"arrival day: keep the schedule light and allow airport transfer.":ctx.dayNumber===t.days?"departure day: leave time for check-out and airport transfer.":"normal sightseeing day.")+" Use these researched attractions as candidate choices: "+list+". Route context: "+ctx.areas.map(a=>a.name+" ("+a.nights+")").join(" → ")+". Return exactly one day object with date, base, title, pace, two or three sensible activities, two or three meal suggestions with numeric per-person prices, overnight and day_estimate. Include activity time, duration, transport, numeric per-person cost, description, booking_url only if verified, and child_friendly note. Do not invent extra bases. Keep text concise.";
 }
 return "";
}
async function runAgent(kind,ctx,env,send,retryBudget){
 const label=ctx.label||kind;
 const model=clip(env.MODEL||"gemini-3.8-flash",80);
 const body={
  model,
  store:false,
  input:promptFor(kind,ctx),
  response_format:{type:"text",mime_type:"application/json",schema:schemas[kind]},
  stream:true,
  generation_config:{max_output_tokens:kind==="route"?900:kind==="flights"?850:kind==="transport"?800:kind==="stay"?750:kind==="attractions"?900:kind==="dining"?650:kind==="guide"?1100:850,thinking_level:"low"}
 };
 if(ctx.useSearch){
  body.tools=[{type:"google_search"}];
 }
 const sources=[],queries=[];
 for(let attempt=0;attempt<2;attempt++){
  let response;
  try{
   response=await fetch("https://generativelanguage.googleapis.com/v1beta/interactions",{
    method:"POST",
    headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY,"Api-Revision":"2026-05-20"},
    body:JSON.stringify(body),
    signal:AbortSignal.timeout(110000)
   });
  }catch(err){
   if(attempt===0&&err?.name!=="TimeoutError"&&retryBudget.remaining>0){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"Connection interrupted; retrying once."});continue}
   throw new Error(label+": "+(err?.name==="TimeoutError"?"AI request timed out after 110 seconds.":"Could not connect to Gemini Interactions API."));
  }
  if([502,503,504].includes(response.status)&&attempt===0&&retryBudget.remaining>0){
   retryBudget.remaining--;
   let wait=Math.min(2500,Number(response.headers.get("retry-after"))*1000||1000);
   try{await response.body?.cancel()}catch{}
   send({type:"agent_retry",agent:label,message:"Gemini temporarily failed (HTTP "+response.status+"); retrying once."});
   await new Promise(resolve=>setTimeout(resolve,wait));
   continue;
  }
  if(!response.ok){
   let text="";try{text=(await response.text()).slice(0,600)}catch{}
   if(ctx.useSearch&&(response.status===400||response.status===403)){
    throw new Error(label+": Gemini rejected the Google Search request (HTTP "+response.status+"). Search grounding may require an eligible billing-enabled project or the provider may have rejected the request configuration. "+text);
   }
   throw new Error(label+": Gemini returned HTTP "+response.status+". "+text);
  }
  if(!response.body)throw new Error(label+": Gemini returned no response stream.");
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer="",output="",status="in_progress",streamError=null;
  const parseFrame=frame=>{
   const lines=frame.split(/\r?\n/);
   const data=lines.filter(x=>x.startsWith("data:")).map(x=>x.slice(5).trim()).join("\n");
   if(!data||data==="[DONE]")return;
   let event;try{event=JSON.parse(data)}catch{return}
   const type=event.event_type||lines.find(x=>x.startsWith("event:"))?.slice(6).trim();
   if(type==="error"){streamError=event.error?.message||"Gemini interaction failed.";return}
   if(type==="step.start"&&event.step?.type==="google_search_call"){
    const qs=event.step.arguments?.queries||[];
    qs.forEach(q=>{if(typeof q==="string"&&!queries.includes(q)){queries.push(q);send({type:"agent_search",agent:label,query:q})}});
   }
   if(type==="step.start"&&event.step?.type==="google_search_result")collectSources(event.step,sources);
   if(type==="step.stop"&&event.step)collectSources(event.step,sources);
   if(type==="step.delta"){
    const delta=event.delta||{};
    if(delta.type==="text"&&typeof delta.text==="string")output+=delta.text;
    if(delta.type==="text_annotation_delta")collectSources(delta.annotations||[],sources);
    if(delta.type==="google_search_result")collectSources(delta.result||[],sources);
    if(delta.type==="google_search_call"){
     const qs=delta.arguments?.queries||delta.queries||[];
     qs.forEach(q=>{if(typeof q==="string"&&!queries.includes(q)){queries.push(q);send({type:"agent_search",agent:label,query:q})}});
    }
   }
   if(type==="interaction.completed"){
    status=event.interaction?.status||"completed";
    if(Array.isArray(event.interaction?.steps))collectSources(event.interaction.steps,sources);
    if(event.interaction?.usage?.grounding_tool_count)send({type:"agent_usage",agent:label,grounding:event.interaction.usage.grounding_tool_count});
   }
  };
  let readError=null;
  try{
   while(true){
    const part=await reader.read();if(part.done)break;
    buffer+=decoder.decode(part.value,{stream:true});
    const frames=buffer.split(/\r?\n\r?\n/);buffer=frames.pop();
    frames.forEach(parseFrame);
    if(streamError)break;
   }
   buffer+=decoder.decode();if(buffer.trim())parseFrame(buffer);
  }catch(err){readError=err}
  finally{try{reader.releaseLock()}catch{}}
  const canRetry=attempt===0&&retryBudget.remaining>0;
  if(readError){
   if(canRetry){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"The response stream was interrupted; retrying once."});continue}
   throw new Error(label+": response stream interrupted: "+(readError?.message||"network error"));
  }
  if(streamError){
   if(canRetry&&/timeout|temporar|overload|gateway|interrupted|unavailable/i.test(streamError)){
    retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"Gemini interrupted the response; retrying once."});continue;
   }
   throw new Error(label+": "+streamError);
  }
  if(status!=="completed"){
   if(canRetry){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"Gemini ended the stream early; retrying once."});continue}
   throw new Error(label+": Gemini stream ended before the interaction was completed (status "+status+").");
  }
  if(!output.trim()){
   if(canRetry){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"Gemini returned no text; retrying once."});continue}
   throw new Error(label+": Gemini stream ended without structured text.");
  }
  let data;try{data=JSON.parse(output.trim())}catch{
   if(canRetry){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"The JSON response was incomplete; retrying once."});continue}
   throw new Error(label+": Gemini returned incomplete JSON.");
  }
  const issue=validateAgent(kind,data,ctx);
  if(issue){
   if(canRetry){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"The response was incomplete; retrying this research task once."});continue}
   throw new Error(label+": "+issue);
  }
  return {data,sources:sourceUnique(sources),queries};
 }
 throw new Error(label+": Gemini was temporarily unavailable after retry.");
}
async function pool(tasks,limit,worker,onFailure){
 let next=0;const results=new Array(tasks.length);
 const runners=Array.from({length:Math.min(limit,tasks.length)},async()=>{
  while(true){
   const i=next++;if(i>=tasks.length)return;
   try{results[i]={ok:true,value:await worker(tasks[i],i)}}
   catch(error){
    const failure={ok:false,error:error?.message||String(error),task:tasks[i]};
    results[i]=failure;
    if(onFailure)onFailure(failure);
   }
  }
 });
 await Promise.all(runners);return results;
}
function makeBaseSchedule(areas,dayCount){
 const schedule=[];
 for(const area of areas){for(let i=0;i<nightsOf(area.nights)&&schedule.length<dayCount-1;i++)schedule.push(area.name)}
 while(schedule.length<dayCount)schedule.push(areas[areas.length-1].name);
 return schedule.slice(0,dayCount);
}
export async function onRequestPost({request,env}){
 try{
  const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return J({error:"Forbidden request."},403);
  if(!env.GEMINI_API_KEY)return J({error:"Server is not configured: GEMINI_API_KEY is missing."},500);
  let b;try{b=await request.json()}catch{return J({error:"Invalid request body."},400)}
  const dest=clip(b.dest,120),d1=clip(b.d1,10),d2=clip(b.d2,10);
  if(!dest||!validDate(d1)||!validDate(d2))return J({error:"Enter a destination and valid travel dates."},400);
  const dayCount=Math.round((Date.parse(d2+"T00:00:00Z")-Date.parse(d1+"T00:00:00Z"))/864e5)+1;
  if(dayCount<1||dayCount>21)return J({error:"Trip duration must be between 1 and 21 days."},400);
  const pax=Math.min(12,Math.max(1,parseInt(b.pax,10)||2));
  const adults=Math.min(pax,Math.max(1,parseInt(b.adults,10)||pax));
  const trip={dest,d1,d2,days:dayCount,pax,adults,bud:clip(b.bud,20)||"Mid-range",cur:clip(b.cur,5)||"INR",from:clip(b.from,60)||"Mumbai",int:clip(b.int,250)};
  const useSearch=b.useSearch===true;
  const maxBases=Math.min(4,Math.max(1,Math.ceil(Math.max(1,dayCount-1)/2)));
  const heartbeat=new TextEncoder();
  let cancelled=false,heartbeatTimer=null,deadlineTimer=null;
  const stream=new ReadableStream({
   start(controller){
    const emit=value=>{if(cancelled)return;try{controller.enqueue(heartbeat.encode("data: "+JSON.stringify(value)+"\n\n"))}catch{cancelled=true}};
    emit({type:"progress",stage:"route",message:"Route architect is selecting the best bases and route…",searchEnabled:useSearch});
    heartbeatTimer=setInterval(()=>emit({type:"heartbeat",message:"Travel research is still running; your connection is active."}),10000);
    // An HTTP-triggered Worker has no hard wall-time cap while the client stays connected.
    // This guard bounds one unusually long overall plan without cutting normal multi-agent runs short.
    deadlineTimer=setTimeout(()=>{emit({type:"error",error:"The research team exceeded its 9-minute safety window. Please retry with fewer travel days or a simpler destination."});cancelled=true;controller.close()},540000);
    (async()=>{
     try{
      const retryBudget={remaining:10};
      const baseCtx={trip,useSearch,maxBases,nights:dayCount-1,label:"Route architect"};
      const route=await runAgent("route",baseCtx,env,emit,retryBudget);
      const areas=normaliseAreas(route.data.areas,dayCount-1,maxBases);
      emit({type:"stage",stage:"research",message:"Route confirmed. Launching independent accommodation, attraction, dining, flight, transport and guide researchers.",agentTotal:areas.length*3+3});
      const tasks=[];
      areas.forEach((area,index)=>{
       tasks.push({kind:"stay",area,index,label:"Stay researcher · "+area.name});
       tasks.push({kind:"attractions",area,index,label:"Attractions researcher · "+area.name});
       tasks.push({kind:"dining",area,index,label:"Dining researcher · "+area.name});
      });
      tasks.push({kind:"flights",label:"Flight researcher"});
      tasks.push({kind:"transport",label:"Transport researcher"});
      tasks.push({kind:"guide",label:"Practical guide & budget researcher"});
      let completed=0;
      const specialistRuns=await pool(tasks,5,async(task)=>{
       emit({type:"agent_started",agent:task.label,completed,total:tasks.length});
       const ctx={trip,useSearch,areas,area:task.area,label:task.label};
       const result=await runAgent(task.kind,ctx,env,emit,retryBudget);
       completed++;
       emit({type:"agent_completed",agent:task.label,completed,total:tasks.length,sourceCount:result.sources.length,searchCount:result.queries.length});
       return {...task,...result};
      },failure=>emit({type:"agent_failed",agent:failure.task.label,error:failure.error}));
      const specialistFailures=specialistRuns.filter(x=>!x.ok);
      if(specialistFailures.length)throw new Error("These research tasks could not complete: "+specialistFailures.map(x=>x.task.label+" — "+x.error).join("; "));
      const specialistResults=specialistRuns.map(x=>x.value);
      const combined={
       ...route.data,
       areas:areas.map(area=>{
        const match=specialistResults.find(x=>x.kind==="stay"&&x.area.name===area.name);
        return {...area,hotel_options:match?.data.hotel_options||[]};
       }),
       flight_options:specialistResults.find(x=>x.kind==="flights")?.data.flight_options||[],
       getting_there:specialistResults.find(x=>x.kind==="flights")?.data.getting_there||"",
       internal_transport:specialistResults.find(x=>x.kind==="transport")?.data.internal_transport||[],
       highlights:specialistResults.filter(x=>x.kind==="attractions").flatMap(x=>x.data.highlights||[]),
       dining:specialistResults.filter(x=>x.kind==="dining").flatMap(x=>x.data.dining||[])
      };
      const guide=specialistResults.find(x=>x.kind==="guide")?.data;
      if(!guide)throw new Error("The practical guide and budget specialist did not complete.");
      Object.assign(combined,guide);
      const schedule=makeBaseSchedule(areas,dayCount);
      const dayDates=Array.from({length:dayCount},(_,i)=>new Date(Date.parse(d1+"T00:00:00Z")+i*864e5).toISOString().slice(0,10));
      emit({type:"stage",stage:"daily",message:"Specialists are complete. Day planners are now building the itinerary one day at a time.",agentTotal:dayCount});
      const dayTasks=dayDates.map((date,index)=>({date,index,base:schedule[index],label:"Day planner · Day "+(index+1)}));
      let daysCompleted=0;
      const dayRuns=await pool(dayTasks,5,async(task)=>{
       const relevant=combined.highlights.filter(h=>String(h.area||"").toLowerCase().includes(task.base.toLowerCase())||task.base.toLowerCase().includes(String(h.area||"").toLowerCase())).slice(0,8);
       emit({type:"agent_started",agent:task.label,completed:daysCompleted,total:dayCount});
       const result=await runAgent("day",{trip,useSearch:false,label:task.label,date:task.date,dayNumber:task.index+1,base:task.base,areas,highlights:relevant},env,emit,retryBudget);
       daysCompleted++;
       emit({type:"agent_completed",agent:task.label,completed:daysCompleted,total:dayCount,sourceCount:result.sources.length,searchCount:0});
       return result.data.days[0];
      },failure=>emit({type:"agent_failed",agent:failure.task.label,error:failure.error}));
      const dayFailures=dayRuns.filter(x=>!x.ok);
      if(dayFailures.length)throw new Error("These daily plans could not complete: "+dayFailures.map(x=>x.task.label+" — "+x.error).join("; "));
      const dayResults=dayRuns.map(x=>x.value);
      combined.days=dayResults.sort((a,b)=>a.date.localeCompare(b.date));
      const allResearch=[{label:"Route architect",sources:route.sources||[],queries:route.queries||[]},...specialistResults];
      combined.research_sources=sourceUnique(allResearch.flatMap(x=>x.sources||[])).map(s=>({...s,agent:allResearch.find(x=>(x.sources||[]).some(a=>a.url===s.url))?.label||"Researcher"}));
      combined.research={search_enabled:useSearch,agents_completed:specialistResults.length+dayResults.length+1,web_sources:combined.research_sources.length,search_queries:allResearch.reduce((sum,x)=>sum+x.queries.length,0)};
      const required=["flight_options","internal_transport","areas","highlights","dining","days","tips","caveats"];
      if(required.some(k=>!Array.isArray(combined[k]))||combined.days.length!==dayCount||!combined.budget||!combined.practical)throw new Error("The completed itinerary failed final completeness checks.");
      if(combined.areas.some(a=>!Array.isArray(a.hotel_options)||!a.hotel_options.length))throw new Error("At least one stay researcher did not return suitable hotel options.");
      if(combined.days.some((d,i)=>d.date!==dayDates[i]||!Array.isArray(d.activities)||d.activities.length<2||!Array.isArray(d.meals)))throw new Error("One or more day planners returned an incomplete daily plan.");
      emit({type:"result",data:combined});
     }catch(err){
      console.error("Trip Planner agent orchestration failed:",err?.stack||err);
      emit({type:"error",error:err?.message||"One or more travel researchers could not complete the plan."});
     }finally{
      clearInterval(heartbeatTimer);clearTimeout(deadlineTimer);
      if(!cancelled){cancelled=true;try{controller.close()}catch{}}
     }
    })();
   },
   cancel(){cancelled=true;clearInterval(heartbeatTimer);clearTimeout(deadlineTimer)}
  });
  return new Response(stream,{status:200,headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-store, no-transform","x-accel-buffering":"no"}});
 }catch(err){console.error("Trip Planner request failure:",err?.stack||err);return J({error:"The travel planning service encountered an internal error."},500)}
}
