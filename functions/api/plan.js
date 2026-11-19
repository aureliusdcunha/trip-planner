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
 flights:obj({getting_there:str,flight_options:arr(obj({segment:str,route:str,airlines:str,flight_number:str,departure:str,arrival:str,duration:str,stops:str,price_estimate:num,adult_price_per_person:num,child_price_per_person:num,infant_price_per_person:num,baggage:str,fare_notes:str,booking_advice:str,booking_url:str}))}),
 transport:obj({internal_transport:arr(obj({mode:str,route:str,duration:str,price_estimate:num,pros:str,booking_advice:str,booking_url:str}))}),
 stay:obj({hotel_options:arr(obj({tier:str,name:str,location:str,stars:str,price_per_night:num,room_notes:str,facilities:str,family_fit:str,airport_transfer:str,why:str,booking_url:str}))}),
 attractions:obj({highlights:arr(obj({name:str,area:str,category:str,duration:str,price_estimate:num,child_price_estimate:num,infant_price_estimate:num,family_price_estimate:num,why_visit:str,practical_tip:str,family_fit:str,booking_url:str}))}),
 dining:obj({dining:arr(obj({name:str,area:str,cuisine:str,signature:str,tier:str,price_per_person:num,adult_price_per_person:num,child_price_per_person:num,infant_price_per_person:num,meal_type:str,why_visit:str,booking_url:str}))}),
 guide:obj({
  practical:obj({entry_requirements:str,visa:str,weather:str,connectivity:str,health_safety:str,money:str,local_etiquette:str,packing:str}),
  budget:obj({currency:str,home_currency:str,exchange_rate_to_home:num,international_flight_per_person:num,international_flight_adult:num,international_flight_child:num,international_flight_infant:num,local_transport_total:num,hotel_per_room_per_night:num,activity_per_person_per_day:num,food_per_person_per_day:num,shopping_per_person:num,contingency_percent:num,assumptions:arr(str)}),
  budget_strategy:obj({flights:str,hotels:str,food:str,experiences:str,transport:str}),
  budget_strategies:arr(obj({style:str,flights:str,hotels:str,food:str,experiences:str,transport:str})),
  shopping_guide:arr(obj({area:str,item:str,category:str,price_estimate:num,tip:str})),
  tips:arr(str),caveats:arr(str)
 }),
 day:obj({days:arr(obj({date:str,base:str,title:str,subtitle:str,pace:str,activities:arr(obj({time:str,name:str,category:str,description:str,duration:str,transport:str,transport_title:str,transport_details:str,cost_estimate:num,adult_cost_estimate:num,child_cost_estimate:num,infant_cost_estimate:num,booking_url:str,child_friendly:str,kid_note:str,shopping_note:str})),meals:arr(obj({time:str,meal:str,suggestion:str,price_estimate:num,adult_price_estimate:num,child_price_estimate:num,infant_price_estimate:num})),overnight:str,day_estimate:num}))})
};
async function getExchangeRate(base,quote){
 const from=String(base||"").toUpperCase(),to=String(quote||"").toUpperCase();
 if(!/^[A-Z]{3}$/.test(from)||!/^[A-Z]{3}$/.test(to))return null;
 if(from===to)return {rate:1,date:"",source:"Same currency"};
 try{
  const response=await fetch("https://api.frankfurter.dev/v2/rate/"+from.toLowerCase()+"/"+to.toLowerCase(),{method:"GET",headers:{"accept":"application/json"},signal:AbortSignal.timeout(7000)});
  if(!response.ok)return null;
  const data=await response.json();
  if(data?.base!==from||data?.quote!==to||!Number.isFinite(data.rate)||data.rate<=0)return null;
  return {rate:data.rate,date:String(data.date||""),source:"Frankfurter reference rates"};
 }catch{return null}
}
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
 if(kind==="flights"&&(!Array.isArray(data.flight_options)||data.flight_options.length<3))return "The flight researcher must return at least three suggested flight options.";
 if(kind==="stay"){
  if(!Array.isArray(data.hotel_options)||data.hotel_options.length<3)return "The accommodation researcher must return budget, mid-range and splurge hotel options.";
  const tiers=new Set(data.hotel_options.map(x=>String(x.tier||"").toLowerCase()));
  if(!["budget","mid","splurge"].every(x=>[...tiers].some(t=>t.includes(x))))return "The accommodation researcher must cover budget, mid-range and splurge tiers.";
 }
 if(kind==="transport"&&(!Array.isArray(data.internal_transport)||!data.internal_transport.length))return "The transport researcher returned no usable transfer options.";

 if(kind==="attractions"&&(!Array.isArray(data.highlights)||data.highlights.length<5))return "The attractions researcher must return at least five distinct experiences.";
 if(kind==="dining"&&(!Array.isArray(data.dining)||data.dining.length<4))return "The dining researcher must return at least four distinct options.";
 if(kind==="guide"){
  const keys=["exchange_rate_to_home","international_flight_per_person","international_flight_adult","international_flight_child","international_flight_infant","local_transport_total","hotel_per_room_per_night","activity_per_person_per_day","food_per_person_per_day","shopping_per_person","contingency_percent"];
  if(!data.practical||!data.budget||keys.some(k=>!Number.isFinite(data.budget[k])||data.budget[k]<0)||!Array.isArray(data.tips)||!Array.isArray(data.caveats)||!data.budget_strategy||!Array.isArray(data.shopping_guide))return "The practical/budget researcher returned incomplete data.";
  if(!Array.isArray(data.budget_strategies)||!["Budget","Mid-range","Luxury"].every(style=>data.budget_strategies.some(x=>String(x.style||"").toLowerCase()===style.toLowerCase())))return "The budget researcher must return Budget, Mid-range and Luxury guidance.";
  if(String(data.budget.currency||"").toUpperCase()!==String(ctx.trip.cur||"").toUpperCase()&&data.budget.exchange_rate_to_home<=0)return "The budget researcher must provide a positive indicative home-currency conversion rate as a fallback.";
 }
 if(kind==="day"){
  if(!Array.isArray(data.days)||data.days.length!==1)return "The day planner must return exactly one day.";
  const d=data.days[0];if(d.date!==ctx.date||!Array.isArray(d.activities)||d.activities.length<3||!Array.isArray(d.meals)||d.meals.length<2)return "The daily plan needs at least three activities, two meals and the requested date.";
  if(d.activities.some(a=>!a.time||!a.name||!a.description||!String(a.transport||a.transport_details||"").trim()||!(a.kid_note||a.child_friendly)||!Number.isFinite(a.adult_cost_estimate)||!Number.isFinite(a.child_cost_estimate)||!Number.isFinite(a.infant_cost_estimate)))return "Every itinerary activity needs a time, useful details, transport notes, a child/family note and adult/child/infant costs.";
  if(d.meals.some(m=>!m.time||!Number.isFinite(m.adult_price_estimate)||!Number.isFinite(m.child_price_estimate)||!Number.isFinite(m.infant_price_estimate)))return "Every meal needs a time and separate adult, child and infant estimates.";
  if(!ctx.trip.includeShopping&&d.activities.some(a=>String(a.shopping_note||"").trim()))return "Shopping stops must be omitted when the traveller has disabled shopping.";
 }
 return null;
}
function promptFor(kind,ctx){
 const t=ctx.trip;
 const ages=t.childAges.length?" Child ages: "+t.childAges.join(", ")+".":" Child ages were not supplied; use conservative child-rate assumptions and state age restrictions where relevant.";
 const party="Travellers: "+t.pax+" total ("+t.adults+" adults, "+t.children+" children, "+t.infants+" infants under 2). Each infant is a lap infant and must have one accompanying adult (infants cannot exceed adults)."+ages+" Budget style: "+t.bud+". Departing from: "+t.from+". Home currency: "+t.cur+". Interests: "+(t.int||"balanced sightseeing, food and culture")+". Shopping included: "+(t.includeShopping?"yes":"no")+".";
 const searchInstruction=ctx.useSearch?"You have Google Search available. Actively run at least one focused search for this exact assignment and ground recommendations in the returned sources; do not rely only on model memory. Prefer official or reputable primary sources.":"Live Google Search was not enabled. Use established knowledge and label prices, schedules and availability as indicative; do not imply you checked live sources.";
 const common="Destination: "+t.dest+". Dates: "+t.d1+" to "+t.d2+" inclusive. "+party+" "+searchInstruction+" Use accurate real places. Do not invent live availability, exact fares, flight schedules or opening hours. All numeric price fields must be in destination local currency (ISO code). Never embed currency amounts or currency symbols in narrative text fields; put all prices only in numeric price fields so the application can convert and display them consistently in the traveller's home currency with local currency in brackets. If uncertain, say so rather than inventing.";
 if(kind==="route")return "You are the ROUTE ARCHITECT for a travel-planning team. Your only task is choosing sensible overnight bases and the route between them. "+common+" Return "+ctx.maxBases+" or fewer bases. The number of nights must add up to exactly "+ctx.nights+"; for a day trip, return one base with 0 nights. Avoid unnecessary backtracking and group geographically. For each base return its name, nights as e.g. '3 nights', and a short reason. Also return overview, best_time, destination_currency, currency_code, local_context and route_summary. currency_code must be the ISO 4217 three-letter currency code for the destination local currency (for example THB, JPY, EUR). Do not return hotels, activities, meals, flights or budget. Keep concise.";
 if(kind==="flights")return "You are the FLIGHT SPECIALIST. Research international flight recommendations from "+t.from+" to "+t.dest+" and return. "+common+" Return at least 3 comparison-ready options: at least one outbound, one return, and a best-value or alternative fare option. Each option must include segment (Outbound, Return or Alternative), route, airlines, flight_number (leave blank unless verified), departure airport/time (write indicative if not verified), arrival airport/time, duration, number of stops, numeric one-way fare estimates per passenger in local currency: price_estimate and adult_price_per_person (adult fare), child_price_per_person and infant_price_per_person. If a child fare is unavailable, use the adult fare as a clearly labelled planning fallback; if an infant lap fare is unavailable, use 10% of the adult fare as a provisional estimate and state the assumption in fare_notes. Include baggage allowance, fare_notes, booking_advice and booking_url. The outbound and return options are separate one-way legs; the Alternative is a choice and must not be added as another leg. Never put a round-trip price in a one-way field. Prefer sensible family itineraries, convenient airport pairings and no unnecessary overnight layovers. If the route is multi-city, include relevant open-jaw or internal flight legs as separate options. Never invent exact flight numbers or times; leave them blank when not verified. Do not claim seats are available. Include getting_there as a concise arrival/departure strategy. No hotels or day plans.";
 if(kind==="transport")return "You are the LOCAL TRANSPORT SPECIALIST. Research only realistic transfer options for this route. "+common+" Route bases: "+ctx.areas.map(a=>a.name+" ("+a.nights+")").join(" → ")+". Return 2-4 useful transfers including mode, route, indicative total or route fare in destination currency, duration and pros. Do not add daily attractions or flights.";
 if(kind==="stay")return "You are the ACCOMMODATION SPECIALIST for "+ctx.area.name+". Research lodging for this base only. "+common+" Suggested stay: "+ctx.area.nights+". Party composition: "+t.pax+" travellers, "+t.adults+" adults, "+t.children+" children and "+t.infants+" infants. Return exactly 3 specific real hotel properties, one in each tier: Budget, Mid-range and Splurge. Do not return generic descriptions in place of property names. For each include tier, name, location/neighbourhood, star category if known, indicative price per night for one family room sized for up to 2 adults + 1 child (infants may share only where property policy allows), in destination local currency; clearly state if this family occupancy requires an extra bed or a second room. Include family room/triple-room notes, facilities (pool, breakfast, shuttle, kids amenities when verified), family_fit, airport_transfer and why it fits this trip. Include booking_url only if a trusted official property or booking page is known. Do not claim rooms are available. Do not research other bases.";
 if(kind==="attractions")return "You are the ATTRACTIONS SPECIALIST for "+ctx.area.name+". Research only real attractions, cultural experiences and activities in or near this base. "+common+" Return 5-8 high-value, distinct experiences suitable for the dates and interests. Each must include area, category, duration, numeric adult price per person, numeric child price per child, numeric infant price per infant, numeric family total for this party where possible using the actual party counts, why visit, practical tip, family_fit and official booking_url only when verified. Use 0 for free activities. State age restrictions and booking lead time when relevant, but do not invent either. No hotels, dining or day-by-day schedule.";
 if(kind==="dining")return "You are the DINING SPECIALIST for "+ctx.area.name+". Research restaurants, food markets, local signature dishes and authentic dining experiences in or near this base. "+common+" Return 6 specific, diverse and family-appropriate options: 2 Budget, 2 Mid-range and 2 Luxury. For each include area, cuisine, signature dish, tier (exactly Budget, Mid-range or Luxury), type of meal (street food, food court, casual, special dinner, etc.), indicative adult_price_per_person, child_price_per_person and infant_price_per_person in destination local currency. These values must be per person for one meal, never a whole-family total or a per-day total. Also include price_per_person as the adult per-meal fallback, why visit, and a reservation/official URL only when verified. Include special-occasion and affordable everyday choices. Do not plan activities or hotels.";
 if(kind==="guide")return "You are the TRAVEL PRACTICALITIES, SHOPPING AND BUDGET SPECIALIST. Research passport-dependent entry guidance, weather for travel dates, connectivity, health/safety, money, etiquette and packing. "+(t.includeShopping?"Also research worthwhile shopping areas and items.":"Shopping research is not required; omit shopping recommendations.")+" "+common+" The traveller home currency is exactly "+t.cur+". In budget.home_currency, return exactly "+t.cur+". budget.currency must be the destination local currency ISO code. The application will override exchange_rate_to_home with a daily reference FX rate when available, but still provide a positive indicative fallback rate (home currency units for one local currency unit) in case the reference-rate service is unavailable. For numeric budget: international_flight_per_person and category flight fares = fallback round-trip fares per traveller only when the flight specialist did not return both outbound and return one-way fares; the application derives round-trip fares by adding the selected outbound and return one-way options when both are present; local_transport_total = whole-party transport total; hotel_per_room_per_night = indicative nightly rate for one family room for up to 2 adults + 1 child, with infants sharing only if permitted; activity_per_person_per_day and food_per_person_per_day = fallback daily averages used only when timed itinerary prices are unavailable; shopping_per_person = per-person whole-trip allowance (0 when shopping is excluded); contingency_percent 10-20. Return budget_strategy for the requested style plus budget_strategies with exactly three style-specific guidance records (Budget, Mid-range, Luxury), each with flights, hotels, food, experiences and transport. Include 4-8 concise budget.assumptions explaining airfare, room occupancy, daily meal basis, child/infant fare assumptions and any exclusions. Return 5-8 shopping_guide items only when shopping is included; otherwise return an empty array. Provide 5-7 family-aware tips and 2-4 caveats. Do not calculate a grand total. Never assert visa eligibility without nationality.";
 if(kind==="day"){
  const list=ctx.highlights.length?ctx.highlights.map(h=>h.name+" — "+h.why_visit).join("; "):"Choose well-known, relevant local experiences.";
  return "You are the DAY PLANNER. Create exactly one realistic, detailed family day for "+ctx.date+" in "+ctx.base+". "+common+" Day number "+ctx.dayNumber+" of "+t.days+"; "+(t.zeroDaysWasted?(ctx.dayNumber===1&&ctx.dayNumber===t.days?"0 days wasted mode on a single-day trip: make the available hours useful, but fit activities only around confirmed/indicative arrival and departure times; if flight times are unknown, keep the plan conservative and clearly state assumptions.":ctx.dayNumber===1?"0 days wasted mode on arrival day: do not write off the day. Use the selected flight's arrival time if available, allow realistic immigration, baggage and airport transfer buffers, then schedule a few nearby, low-effort activities and a meal only in the remaining usable time. Never schedule before arrival or imply the whole day is available.":ctx.dayNumber===t.days?"0 days wasted mode on departure day: do not write off the day. Use the selected return flight's departure time if available, allow check-out, baggage and airport transfer buffers, and schedule a nearby activity and meal only before the safe airport departure time. Never schedule after the flight or compromise airport arrival buffer.":"normal sightseeing day with realistic opening hours and travel time."):(ctx.dayNumber===1?"arrival day: respect arrival/airport transfer and avoid an exhausting schedule.":ctx.dayNumber===t.days?"departure day: allow time for check-out, baggage and airport transfer.":"normal sightseeing day with realistic opening hours and travel time."))+" Use these researched attractions as candidate choices: "+list+". Route context: "+ctx.areas.map(a=>a.name+" ("+a.nights+")").join(" → ")+". Return exactly one day with a clear title, useful subtitle, pace, 4-7 chronological activity/transfer entries and 2-3 timed meal suggestions, overnight base and whole-party day_estimate. Each activity must include a realistic local time slot, category, duration, transport summary, a short transport_title and detailed transport_details with practical mode/options/transfer guidance where useful, numeric adult_cost_estimate, child_cost_estimate and infant_cost_estimate in local currency (plus cost_estimate as adult fallback), useful practical description, booking_url only if verified, a short child_friendly label and a specific kid_note (comfort, age suitability, restrooms, stroller/nap or safety guidance). Keep kid_note specific rather than generic. "+(t.includeShopping?"Include a shopping stop only if geographically sensible; keep total shopping time to no more than 3 hours in the day and put practical items/market tips in shopping_note.":"Shopping is excluded; do not schedule markets, malls, souvenir stops or shopping breaks and leave shopping_note empty.")+" Group nearby places, include travel/transfer time, leave breaks and do not overfill the day. Meals must include a clear time and separate adult_price_estimate, child_price_estimate and infant_price_estimate (plus price_estimate as adult fallback). Each meal estimate must be per person for that single meal, not a whole-family total or a daily food total. Do not invent extra bases or currency amounts in text. Keep text concise but actionable.";
 }
 return "";
}
function advanceModel(modelState,failedModel){
 const current=modelState.models[modelState.index];
 if(current===failedModel&&modelState.index<modelState.models.length-1)modelState.index++;
 const next=modelState.models[modelState.index];
 return next!==failedModel?next:null;
}
function createRequestGate(limit,spacingMs){return {limit,spacingMs,active:0,queue:[],nextStartAt:0,pauseUntil:0}}
async function acquireRequestSlot(gate){
 if(gate.active<gate.limit&&gate.queue.length===0)gate.active++;
 else await new Promise(resolve=>gate.queue.push(resolve));
 while(true){
  const now=Date.now(),wait=Math.max(gate.nextStartAt-now,gate.pauseUntil-now);
  if(wait<=0)break;
  await new Promise(resolve=>setTimeout(resolve,wait));
 }
 const now=Date.now();
 gate.nextStartAt=Math.max(now,gate.nextStartAt)+gate.spacingMs;
}
function rateLimitCooldownSeconds(details){
 const text=String(details||"");
 const retry=text.match(/retry\s+in\s+(\d+)\s*(s|sec(?:onds?)?|m|min(?:utes?)?)/i);
 if(retry){
  const amount=Number(retry[1]);
  const unit=retry[2].toLowerCase();
  const seconds=unit.startsWith("m")?amount*60:amount;
  return seconds>0&&seconds<=120?seconds:0;
 }
 return /requests?\s+per\s+minute|per minute/i.test(text)?60:0;
}
function releaseRequestSlot(gate){
 if(gate.queue.length){const next=gate.queue.shift();next()}
 else gate.active=Math.max(0,gate.active-1);
}
function isCapacityError(message){
 return /high demand|spikes? in demand|currently experiencing|capacity|overload|resource_exhausted|temporar|unavailable|gateway|server busy/i.test(String(message||""));
}
async function runAgent(kind,ctx,env,send,retryBudget,modelState,requestBudget,requestGate){
 const label=ctx.label||kind,sources=[],queries=[];
 const outputLimits={route:1400,flights:2200,transport:1400,stay:2000,attractions:3400,dining:2400,guide:3200,day:4600};
 let maxOutputTokens=outputLimits[kind]||2000,incompleteRetryCount=0;
 let lastModel="",capacityRetriesForModel=0;
 for(let attempt=0;attempt<20;attempt++){
  await acquireRequestSlot(requestGate);
  const model=modelState.models[modelState.index];
  if(model!==lastModel){lastModel=model;capacityRetriesForModel=0}
  const modelIsFallback=modelState.index>0;
  const useSearch=ctx.useSearch&&!(modelState.freeTier&&modelIsFallback);
  if(ctx.useSearch&&!useSearch&&!modelState.searchNoticeSent){
   modelState.searchNoticeSent=true;
   send({type:"model_notice",message:"The Free Tier does not provide Google Search grounding for the fallback models. Continuing with model knowledge; prices and availability remain estimates."});
  }
  if(requestBudget.remaining<=0){releaseRequestSlot(requestGate);throw new Error(label+": the request safety budget is exhausted. Please retry later or reduce trip length.")}
  requestBudget.remaining--;
  const body={
   model,store:false,input:promptFor(kind,ctx),
   response_format:{type:"text",mime_type:"application/json",schema:schemas[kind]},stream:true,
   generation_config:{max_output_tokens:maxOutputTokens,thinking_level:"low"}
  };
  if(useSearch)body.tools=[{type:"google_search"}];
  let response;
  try{
   response=await fetch("https://generativelanguage.googleapis.com/v1beta/interactions",{
    method:"POST",headers:{"content-type":"application/json","x-goog-api-key":env.GEMINI_API_KEY,"Api-Revision":"2026-05-20"},
    body:JSON.stringify(body),signal:AbortSignal.timeout(110000)
   });
  }catch(err){
   releaseRequestSlot(requestGate);
   if(attempt<11&&err?.name!=="TimeoutError"&&retryBudget.remaining>0){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"Connection interrupted; retrying once."});continue}
   throw new Error(label+": "+(err?.name==="TimeoutError"?"AI request timed out after 110 seconds.":"Could not connect to Gemini Interactions API."));
  }
  if(response.status===429){
   let details="";try{details=(await response.text()).slice(0,700)}catch{}
   releaseRequestSlot(requestGate);
   if(/free.?tier|FreeTier/i.test(details))modelState.freeTier=true;
   const cooldownSeconds=rateLimitCooldownSeconds(details);
   if(cooldownSeconds){
    requestGate.pauseUntil=Math.max(requestGate.pauseUntil,Date.now()+(cooldownSeconds+1)*1000);
    send({type:"model_wait",agent:label,model,seconds:cooldownSeconds+1,message:"Gemini rate limit reached for "+model+". Pausing all researchers for about "+(cooldownSeconds+1)+" seconds, then retrying this model."});
    continue;
   }
   const next=advanceModel(modelState,model);
   if(next){modelState.switched=true;send({type:"model_fallback",agent:label,from:model,to:next,freeTier:modelState.freeTier,searchDisabled:!!(modelState.freeTier&&ctx.useSearch),message:"Quota/rate limit reached for "+model+". Switching to "+next+"."});continue}
   throw new Error(label+": all configured Gemini models are rate-limited (HTTP 429). "+details+" Wait for the quota reset or enable Gemini billing for higher limits.");
  }
  if(!response.ok){
   let details="";try{details=(await response.text()).slice(0,700)}catch{}
   releaseRequestSlot(requestGate);
   const transient=[502,503,504].includes(response.status)||isCapacityError(details);
   if(transient){
    if(capacityRetriesForModel<1&&retryBudget.remaining>0&&attempt<11){
     capacityRetriesForModel++;retryBudget.remaining--;
     const delay=1000*Math.pow(2,capacityRetriesForModel-1);
     send({type:"agent_retry",agent:label,message:"Gemini is temporarily overloaded (HTTP "+response.status+"); retrying after "+(delay/1000)+"s."});
     await new Promise(resolve=>setTimeout(resolve,delay));continue;
    }
    const next=advanceModel(modelState,model);
    if(next){modelState.switched=true;send({type:"model_fallback",agent:label,from:model,to:next,freeTier:modelState.freeTier,searchDisabled:!!(modelState.freeTier&&ctx.useSearch),message:"Model "+model+" is temporarily overloaded. Switching to "+next+"."});continue}
   }
   if(useSearch&&(response.status===400||response.status===403))throw new Error(label+": Gemini rejected the Google Search request (HTTP "+response.status+"). Search grounding may require an eligible billing-enabled project or the provider may have rejected the request configuration. "+details);
   if(transient)throw new Error(label+": all configured Gemini models are currently overloaded or unavailable. Please wait a few minutes and retry. Last response: HTTP "+response.status+". "+details);
   throw new Error(label+": Gemini returned HTTP "+response.status+". "+details);
  }
  if(!response.body){releaseRequestSlot(requestGate);throw new Error(label+": Gemini returned no response stream.")}
  const reader=response.body.getReader(),decoder=new TextDecoder();
  let buffer="",output="",status="in_progress",streamError=null;
  const parseFrame=frame=>{
   const lines=frame.split(/\r?\n/),data=lines.filter(x=>x.startsWith("data:")).map(x=>x.slice(5).trim()).join("\n");
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
   while(true){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});const frames=buffer.split(/\r?\n\r?\n/);buffer=frames.pop();frames.forEach(parseFrame)}
   buffer+=decoder.decode();if(buffer.trim())parseFrame(buffer);
  }catch(err){readError=err}
  finally{try{reader.releaseLock()}catch{}releaseRequestSlot(requestGate)}
  const canRetry=attempt<19&&retryBudget.remaining>0;
  if(readError){
   if(canRetry){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"The response stream was interrupted; retrying once."});continue}
   throw new Error(label+": response stream interrupted: "+(readError?.message||"network error"));
  }
  if(streamError){
   if(isCapacityError(streamError)){
    if(capacityRetriesForModel<1&&retryBudget.remaining>0&&attempt<19){
     capacityRetriesForModel++;retryBudget.remaining--;
     const delay=1000*Math.pow(2,capacityRetriesForModel-1);
     send({type:"agent_retry",agent:label,message:"Gemini reports high demand; retrying after "+(delay/1000)+"s."});
     await new Promise(resolve=>setTimeout(resolve,delay));continue;
    }
    const next=advanceModel(modelState,model);
    if(next){modelState.switched=true;send({type:"model_fallback",agent:label,from:model,to:next,freeTier:modelState.freeTier,searchDisabled:!!(modelState.freeTier&&ctx.useSearch),message:"Model "+model+" remains overloaded. Switching to "+next+"."});continue}
   }
   if(isCapacityError(streamError))throw new Error(label+": all configured Gemini models are currently experiencing high demand. Please wait a few minutes and retry. "+streamError);
   throw new Error(label+": "+streamError);
  }
  let data=null,validationIssue="No structured JSON was returned.";
  if(output.trim()){
   try{data=JSON.parse(output.trim());validationIssue=validateAgent(kind,data,ctx)}
   catch{validationIssue="Gemini returned incomplete or invalid JSON."}
  }
  if((status==="completed"||status==="incomplete")&&data&&!validationIssue){
   if(status==="incomplete")send({type:"agent_notice",agent:label,message:"Gemini marked the interaction incomplete, but the returned JSON passed all required checks; retaining the validated result."});
   return {data,sources:sourceUnique(sources),queries,model,status,maxOutputTokens};
  }
  if(status==="incomplete"){
   if(incompleteRetryCount===0&&requestBudget.remaining>0&&attempt<19){
    incompleteRetryCount++;
    const previous=maxOutputTokens;
    maxOutputTokens=Math.min(8192,Math.max(previous+1000,previous*2));
    send({type:"agent_retry",agent:label,message:"Gemini stopped at its output-token limit. Retrying with "+maxOutputTokens+" output tokens (previously "+previous+")."});
    continue;
   }
   if(incompleteRetryCount===1){
    const next=advanceModel(modelState,model);
    if(next&&requestBudget.remaining>0&&attempt<19){
     incompleteRetryCount++;
     modelState.switched=true;
     send({type:"model_fallback",agent:label,from:model,to:next,freeTier:modelState.freeTier,searchDisabled:!!(modelState.freeTier&&ctx.useSearch),message:"The response remained incomplete after increasing its output limit. Retrying "+label+" with "+next+"."});
     continue;
    }
   }
   throw new Error(label+": Gemini still returned an incomplete response after increasing the output limit to "+maxOutputTokens+" tokens. "+validationIssue);
  }
  if(status!=="completed"){
   if(canRetry){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"Gemini ended the stream before completion; retrying once."});continue}
   throw new Error(label+": Gemini stream ended before the interaction was completed (status "+status+").");
  }
  if(!output.trim()||validationIssue){
   if(canRetry){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"The structured response was incomplete; retrying this research task once."});continue}
   throw new Error(label+": "+validationIssue);
  }
  return {data,sources:sourceUnique(sources),queries,model,status,maxOutputTokens};
 }
 throw new Error(label+": Gemini was temporarily unavailable after all configured model attempts.");
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
  const adults=Math.min(12,Math.max(1,parseInt(b.adults,10)||1));
  const children=Math.max(0,Math.min(12,parseInt(b.children,10)||0));
  const infants=Math.max(0,Math.min(12,parseInt(b.infants,10)||0));
  if(infants>adults)return J({error:"Infants cannot exceed adults; each lap infant needs an accompanying adult."},400);
  const pax=adults+children+infants;
  if(pax>12)return J({error:"The total party size (adults, children and infants) cannot exceed 12."},400);
  const childAges=Array.isArray(b.childAges)?b.childAges.map(x=>Number.parseInt(x,10)).filter(x=>Number.isInteger(x)&&x>=2&&x<=17).slice(0,12):[];
  if(childAges.length&&childAges.length!==children)return J({error:"Enter one age (2–17) for each child, or leave child ages blank."},400);
  const trip={dest,d1,d2,days:dayCount,pax,adults,children,infants,childAges,bud:clip(b.bud,20)||"Mid-range",cur:clip(b.cur,5)||"INR",from:clip(b.from,60)||"Mumbai",int:clip(b.int,250),includeShopping:b.includeShopping!==false,zeroDaysWasted:b.zeroDaysWasted===true};
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
      // 21-day / four-base plans use at most 37 agents. The shared request budget caps model rotations and retries at 49 calls; the gate allows at most two in-flight calls.
      const primaryModel=clip(env.MODEL||"gemini-3.8-flash",80);
      const configuredFallback=clip(env.FALLBACK_MODEL||"gemini-3.5-flash-lite",80);
      const tertiaryModel=clip(env.TERTIARY_MODEL||"gemini-3.1-flash-lite",80);
      const modelCandidates=[primaryModel,configuredFallback,tertiaryModel].filter((model,index,list)=>model&&list.indexOf(model)===index);
      const modelState={primary:primaryModel,models:modelCandidates,index:0,switched:false,freeTier:false,searchNoticeSent:false};
      const retryBudget={remaining:7};
      const requestBudget={remaining:49};
      const requestGate=createRequestGate(2,4300);
      // Route, flight and practical/budget research are independent and start together.
      const openingTasks=[
       {kind:"route",label:"Route architect"},
       {kind:"flights",label:"Flight researcher"},
       {kind:"guide",label:"Practical guide & budget researcher"}
      ];
      let openingCompleted=0;
      emit({type:"stage",stage:"opening",message:"Launching route, flight and budget specialists in parallel…",agentTotal:openingTasks.length});
      const openingRuns=await pool(openingTasks,3,async(task)=>{
       emit({type:"agent_started",agent:task.label,completed:openingCompleted,total:openingTasks.length});
       const ctx={trip,useSearch,maxBases,nights:dayCount-1,label:task.label};
       const result=await runAgent(task.kind,ctx,env,emit,retryBudget,modelState,requestBudget,requestGate);
       openingCompleted++;
       emit({type:"agent_completed",agent:task.label,completed:openingCompleted,total:openingTasks.length,sourceCount:result.sources.length,searchCount:result.queries.length});
       return {...task,...result};
      },failure=>emit({type:"agent_failed",agent:failure.task.label,error:failure.error}));
      const openingFailures=openingRuns.filter(x=>!x.ok);
      if(openingFailures.length)throw new Error("These initial research tasks could not complete: "+openingFailures.map(x=>x.task.label+" — "+x.error).join("; "));
      const openingResults=openingRuns.map(x=>x.value);
      const route=openingResults.find(x=>x.kind==="route");
      const areas=normaliseAreas(route.data.areas,dayCount-1,maxBases);
      const fxRatePromise=getExchangeRate(route.data.currency_code,trip.cur);
      emit({type:"stage",stage:"research",message:"Route confirmed. Launching area-specific stay, attraction, dining and local transport researchers.",agentTotal:areas.length*3+1});
      const tasks=[];
      areas.forEach((area,index)=>{
       tasks.push({kind:"stay",area,index,label:"Stay researcher · "+area.name});
       tasks.push({kind:"attractions",area,index,label:"Attractions researcher · "+area.name});
       tasks.push({kind:"dining",area,index,label:"Dining researcher · "+area.name});
      });
      tasks.push({kind:"transport",label:"Transport researcher"});
      let completed=0;
      const specialistRuns=await pool(tasks,5,async(task)=>{
       emit({type:"agent_started",agent:task.label,completed,total:tasks.length});
       const ctx={trip,useSearch,areas,area:task.area,label:task.label};
       const result=await runAgent(task.kind,ctx,env,emit,retryBudget,modelState,requestBudget,requestGate);
       completed++;
       emit({type:"agent_completed",agent:task.label,completed,total:tasks.length,sourceCount:result.sources.length,searchCount:result.queries.length});
       return {...task,...result};
      },failure=>emit({type:"agent_failed",agent:failure.task.label,error:failure.error}));
      const specialistFailures=specialistRuns.filter(x=>!x.ok);
      if(specialistFailures.length)throw new Error("These research tasks could not complete: "+specialistFailures.map(x=>x.task.label+" — "+x.error).join("; "));
      const specialistResults=[...openingResults.filter(x=>x.kind!=="route"),...specialistRuns.map(x=>x.value)];
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
      const localCurrency=String(route.data.currency_code||guide.budget.currency||"").toUpperCase();
      const homeCurrency=String(trip.cur||"INR").toUpperCase();
      const fxRate=await fxRatePromise;
      guide.budget.currency=localCurrency;
      guide.budget.home_currency=homeCurrency;
      if(localCurrency===homeCurrency){
       guide.budget.exchange_rate_to_home=1;
       guide.budget.exchange_rate_date="";
       guide.budget.exchange_rate_source="Same currency";
      }else if(fxRate){
       guide.budget.exchange_rate_to_home=fxRate.rate;
       guide.budget.exchange_rate_date=fxRate.date;
       guide.budget.exchange_rate_source=fxRate.source;
      }else{
       guide.budget.exchange_rate_to_home=Number(guide.budget.exchange_rate_to_home)>0?guide.budget.exchange_rate_to_home:0;
       guide.budget.exchange_rate_source=guide.budget.exchange_rate_to_home>0?"Model-estimated reference rate":"Unavailable";
       guide.budget.exchange_rate_date="";
       guide.caveats.push("The reference FX service was unavailable. Home-currency amounts use the model's indicative rate where available; verify the exchange rate before booking.");
      }
      Object.assign(combined,guide);
      const schedule=makeBaseSchedule(areas,dayCount);
      const dayDates=Array.from({length:dayCount},(_,i)=>new Date(Date.parse(d1+"T00:00:00Z")+i*864e5).toISOString().slice(0,10));
      emit({type:"stage",stage:"daily",message:"Specialists are complete. Day planners are now building the itinerary one day at a time.",agentTotal:dayCount});
      const dayTasks=dayDates.map((date,index)=>({date,index,base:schedule[index],label:"Day planner · Day "+(index+1)}));
      let daysCompleted=0;
      const dayRuns=await pool(dayTasks,5,async(task)=>{
       const relevant=combined.highlights.filter(h=>String(h.area||"").toLowerCase().includes(task.base.toLowerCase())||task.base.toLowerCase().includes(String(h.area||"").toLowerCase())).slice(0,8);
       emit({type:"agent_started",agent:task.label,completed:daysCompleted,total:dayCount});
       const result=await runAgent("day",{trip,useSearch:false,label:task.label,date:task.date,dayNumber:task.index+1,base:task.base,areas,highlights:relevant},env,emit,retryBudget,modelState,requestBudget,requestGate);
       daysCompleted++;
       emit({type:"agent_completed",agent:task.label,completed:daysCompleted,total:dayCount,sourceCount:result.sources.length,searchCount:0});
       return {day:result.data.days[0],model:result.model};
      },failure=>emit({type:"agent_failed",agent:failure.task.label,error:failure.error}));
      const dayFailures=dayRuns.filter(x=>!x.ok);
      if(dayFailures.length)throw new Error("These daily plans could not complete: "+dayFailures.map(x=>x.task.label+" — "+x.error).join("; "));
      const dayResults=dayRuns.map(x=>x.value);
      combined.days=dayResults.map(x=>x.day).sort((a,b)=>a.date.localeCompare(b.date));
      const allResearch=[{label:"Route architect",sources:route.sources||[],queries:route.queries||[]},...specialistResults];
      combined.research_sources=sourceUnique(allResearch.flatMap(x=>x.sources||[])).map(s=>({...s,agent:allResearch.find(x=>(x.sources||[]).some(a=>a.url===s.url))?.label||"Researcher"}));
      const modelsUsed=Array.from(new Set([route.model,...specialistResults.map(x=>x.model),...dayResults.map(x=>x.model)].filter(Boolean)));
      combined.research={search_requested:useSearch,search_enabled:useSearch&&!(modelState.freeTier&&modelState.switched),search_disabled_for_free_tier_fallback:modelState.freeTier&&modelState.switched&&useSearch,primary_model:modelState.primary,fallback_models:modelState.models.slice(1),model_fallback_used:modelState.switched,model_used:modelsUsed.length===1?modelsUsed[0]:modelsUsed.join(", "),models_used:modelsUsed,agents_completed:specialistResults.length+dayResults.length+1,web_sources:combined.research_sources.length,search_queries:allResearch.reduce((sum,x)=>sum+x.queries.length,0)};
      const required=["flight_options","internal_transport","areas","highlights","dining","days","tips","caveats","shopping_guide"];
      if(required.some(k=>!Array.isArray(combined[k]))||combined.days.length!==dayCount||!combined.budget||!combined.practical)throw new Error("The completed itinerary failed final completeness checks.");
      if(combined.areas.some(a=>!Array.isArray(a.hotel_options)||!a.hotel_options.length))throw new Error("At least one stay researcher did not return suitable hotel options.");
      if(combined.days.some((d,i)=>d.date!==dayDates[i]||!Array.isArray(d.activities)||d.activities.length<3||!Array.isArray(d.meals)||d.meals.length<2))throw new Error("One or more day planners returned an incomplete daily plan.");
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
