import { withTransactionLog, traceEvent } from "../lib/transaction-log.js";
import { runWorkersAIWithQuota } from "../lib/ai-quota.js";
import { makeTripCacheKey, readTripReportCache, writeTripReportCache } from "../lib/trip-cache.js";
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
 flights:obj({getting_there:str,flight_options:arr(obj({segment:str,route:str,airlines:str,cabin_class:str,flight_number:str,departure:str,arrival:str,duration:str,stops:str,flight_legs:arr(obj({from:str,to:str,flight_number:str,departure:str,arrival:str})),price_estimate:num,adult_price_per_person:num,child_price_per_person:num,infant_price_per_person:num,fare_range_min:num,fare_range_max:num,baggage:str,fare_notes:str,booking_advice:str,booking_url:str}))}),
 transport:obj({internal_transport:arr(obj({mode:str,route:str,duration:str,price_estimate:num,pros:str,booking_advice:str,booking_url:str}))}),
 stay:obj({hotel_options:arr(obj({tier:str,name:str,location:str,stars:str,price_per_night:num,room_notes:str,facilities:str,family_fit:str,airport_transfer:str,why:str,booking_url:str}))}),
 attractions:obj({highlights:arr(obj({name:str,area:str,category:str,duration:str,price_estimate:num,child_price_estimate:num,infant_price_estimate:num,family_price_estimate:num,why_visit:str,practical_tip:str,family_fit:str,booking_url:str}))}),
 dining:obj({dining:arr(obj({name:str,area:str,cuisine:str,signature:str,tier:str,price_per_person:num,adult_price_per_person:num,child_price_per_person:num,infant_price_per_person:num,meal_type:str,why_visit:str,booking_url:str}))}),
 guide:obj({
  practical:obj({entry_requirements:str,visa:str,weather:str,connectivity:str,health_safety:str,money:str,local_etiquette:str,packing:str}),
  budget:obj({currency:str,home_currency:str,exchange_rate_to_home:num,international_flight_per_person:num,international_flight_adult:num,international_flight_child:num,international_flight_infant:num,local_transport_total:num,hotel_per_room_per_night:num,activity_per_person_per_day:num,food_per_person_per_day:num,shopping_per_person:num,contingency_percent:num,assumptions:arr(str)}),
  budget_strategy:obj({flights:str,hotels:str,food:str,experiences:str,transport:str}),
  budget_strategies:arr(obj({style:str,flights:str,hotels:str,food:str,experiences:str,transport:str})),
  shopping_guide:arr(obj({area:str,item:str,category:str,price_estimate:num,tip:str,places:arr(obj({name:str,area:str,category:str,address:str,why_visit:str,price_level:str,website:str}))})),
  tips:arr(str),caveats:arr(str)
 }),
 day:obj({days:arr(obj({date:str,base:str,title:str,subtitle:str,pace:str,activities:arr(obj({time:str,name:str,category:str,description:str,duration:str,transport:str,transport_title:str,transport_details:str,cost_estimate:num,adult_cost_estimate:num,child_cost_estimate:num,infant_cost_estimate:num,booking_url:str,child_friendly:str,kid_note:str,shopping_note:str})),meals:arr(obj({time:str,meal:str,suggestion:str,price_estimate:num,adult_price_estimate:num,child_price_estimate:num,infant_price_estimate:num})),overnight:str,day_estimate:num}))})
};
function normaliseFlightCurrency(options,fromCurrency,toCurrency,rate){
 const from=String(fromCurrency||"").toUpperCase(),to=String(toCurrency||"").toUpperCase(),fx=Number(rate);
 if(!Array.isArray(options)||!from||!to||from===to||!(fx>0))return {converted:0,from,to,rate:fx||null};
 let converted=0;
 for(const option of options){
  const rawCurrency=option.provider_currency||option.currency;
  if(!rawCurrency)continue;
  const declared=String(rawCurrency).toUpperCase();
  if(declared!==from)continue;
  for(const key of ["price_estimate","adult_price_per_person","child_price_per_person","infant_price_per_person","fare_range_min","fare_range_max","provider_total_amount"]){
   const value=Number(option[key]);if(Number.isFinite(value)&&value>0)option[key]=Number((value/fx).toFixed(2));
  }
  option.provider_currency_original=from;option.provider_currency=to;option.currency=to;option.currency_conversion_rate=fx;
  option.currency_conversion_note="Converted from "+from+" to "+to+" using reference rate "+fx;converted++;
 }
 return {converted,from,to,rate:fx};
}
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
function validateFlightFareScale(flightData,budget,fxRate,homeCurrency){
 const options=Array.isArray(flightData?.flight_options)?flightData.flight_options:[];
 const currency=String(homeCurrency||"INR").toUpperCase();
 const baseCeiling=({INR:300000,USD:5000,EUR:5000,GBP:4000,AUD:7500,CAD:7000,SGD:6500,HKD:40000,AED:18000}[currency]||5000);
 const rate=Number(fxRate?.rate)||Number(budget?.exchange_rate_to_home)||0;
 let checked=0,invalid=0;
 for(const option of options){
  const segment=String(option.segment||"").trim().toLowerCase();
  if(!["outbound","return","alternative"].includes(segment))continue;
  const fare=Number(option.adult_price_per_person??option.price_estimate);
  if(!(fare>0)||!Number.isFinite(fare))continue;
  checked++;
  const cabin=String(option.cabin_class||"Economy").toLowerCase();
  const cabinMultiplier=cabin.includes("first")?5:cabin.includes("business")?3:cabin.includes("premium")?1.7:1;
  const maxOneWayHome=baseCeiling*cabinMultiplier;
  const maxOneWayLocal=rate>0?maxOneWayHome/rate:0;
  if(maxOneWayLocal>0&&fare*rate>maxOneWayHome){
   option.price_estimate=0;
   option.adult_price_per_person=0;
   option.child_price_per_person=0;
   option.infant_price_per_person=0;
   option.price_unverified=true;
   option.fare_notes=[String(option.fare_notes||"").trim(),"Fare rejected by the currency-scale check: the model estimate exceeds the generous "+currency+" "+maxOneWayHome.toLocaleString("en-US")+" cabin-adjusted one-way planning ceiling. No fare is displayed or included in the trip budget; verify this route with an airline or booking provider."].filter(Boolean).join(" ");
   invalid++;
  }
 }
 const validOutbound=options.some(x=>String(x.segment||"").trim().toLowerCase()==="outbound"&&Number(x.price_estimate)>0);
 const validReturn=options.some(x=>String(x.segment||"").trim().toLowerCase()==="return"&&Number(x.price_estimate)>0);
 return {checked,invalid,validOutbound,validReturn,baseCeiling,maxOneWayHome:baseCeiling,homeCurrency:currency,roundTripUsable:validOutbound&&validReturn};
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
function timeStartMinutes(value){
 const match=String(value||"").match(/(?:^|\b)([01]?\d|2[0-3]):([0-5]\d)\b/);
 return match?Number(match[1])*60+Number(match[2]):null;
}
function validateAgent(kind,data,ctx){
 if(!data||typeof data!=="object")return "The "+kind+" researcher returned no structured result.";
 if(kind==="route"&&(!Array.isArray(data.areas)||!data.areas.length))return "The route researcher did not identify overnight bases.";
 if(kind==="flights"){
  const options=Array.isArray(data.flight_options)?data.flight_options:[];
  const validRange=x=>Number(x?.fare_range_min)>0&&Number(x?.fare_range_max)>=Number(x?.fare_range_min)&&Number(x?.price_estimate)>0;
  const outbound=options.filter(x=>String(x?.segment||"").trim().toLowerCase()==="outbound"&&validRange(x));
  const returning=options.filter(x=>String(x?.segment||"").trim().toLowerCase()==="return"&&validRange(x));
  if(!outbound.length||!returning.length)return "The Gemini flight researcher must return a positive indicative fare range for both outbound and return one-way travel. Do not invent flight numbers, exact schedules or exact fares; return ranges only.";
 }
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
  const isArrivalDay=ctx.dayNumber===1,isDepartureDay=ctx.dayNumber===ctx.trip.days;
  if(!isArrivalDay&&!isDepartureDay){
   const activityStarts=d.activities.map(a=>timeStartMinutes(a.time)).filter(x=>x!==null);
   if(!activityStarts.length||Math.min(...activityStarts)>570)return "This is a full sightseeing day, so schedule the first activity by 09:30. Do not leave the morning empty or begin with lunch.";
  }
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
  if(kind==="flights")return "You are the GEMINI FLIGHT FARE-RANGE ESTIMATOR for this trip plan. Do NOT call SerpApi, do NOT call any flight API, and do NOT claim to have searched live booking inventory. Use Gemini reasoning and Google Search grounding when available to estimate a realistic current planning range for this route and these dates. Route: "+t.from+" to "+t.dest+". Dates: outbound "+t.d1+", return "+t.d2+". "+party+" Cabin preference: "+(t.cabin||"Economy")+". Stops preference: "+(t.stops||"Any")+". Return exactly one Outbound and one Return option, each representing a broad fare range per adult for a one-way journey in destination local currency (ISO code). Set fare_range_min and fare_range_max to plausible low/high endpoints, and price_estimate plus adult_price_per_person to the midpoint of that range. These are indicative planning estimates, NOT verified live fares. Do not create individual airline cards, flight numbers, precise departure/arrival times, exact durations or claimed availability. Use airlines field as a short label such as 'Indicative airline mix' and route as the city/airport pair only. Set flight_legs to an empty array, stops to 'Varies', cabin_class to the requested cabin, child_price_per_person to the adult midpoint as a clearly labelled planning fallback, and infant_price_per_person to 10% of adult midpoint as a provisional lap-infant estimate. Include fare_notes stating the date/route assumptions, that the range is Gemini-estimated and unverified, and that final fare depends on airline, baggage, stopovers and booking time. Include getting_there with practical route/airport guidance but no fabricated schedules. Never invent exact prices or represent a range midpoint as a live quote. No SerpApi usage for plan generation.";
 if(kind==="transport")return "You are the LOCAL TRANSPORT SPECIALIST. Research only realistic transfer options for this route. "+common+" Route bases: "+ctx.areas.map(a=>a.name+" ("+a.nights+")").join(" → ")+". Return 2-4 useful transfers including mode, route, indicative total or route fare in destination currency, duration and pros. Do not add daily attractions or flights.";
 if(kind==="stay")return "You are the ACCOMMODATION SPECIALIST for "+ctx.area.name+". Research lodging for this base only. "+common+" Suggested stay: "+ctx.area.nights+". Party composition: "+t.pax+" travellers, "+t.adults+" adults, "+t.children+" children and "+t.infants+" infants. Return exactly 3 specific real hotel properties, one in each tier: Budget, Mid-range and Splurge. Do not return generic descriptions in place of property names. For each include tier, name, location/neighbourhood, star category if known, indicative price per night for one family room sized for up to 2 adults + 1 child (infants may share only where property policy allows), in destination local currency; clearly state if this family occupancy requires an extra bed or a second room. Include family room/triple-room notes, facilities (pool, breakfast, shuttle, kids amenities when verified), family_fit, airport_transfer and why it fits this trip. Include booking_url only if a trusted official property or booking page is known. Do not claim rooms are available. Do not research other bases.";
 if(kind==="attractions")return "You are the ATTRACTIONS SPECIALIST for "+ctx.area.name+". Research only real attractions, cultural experiences and activities in or near this base. "+common+" Return 5-8 high-value, distinct experiences suitable for the dates and interests. Each must include area, category, duration, numeric adult price per person, numeric child price per child, numeric infant price per infant, numeric family total for this party where possible using the actual party counts, why visit, practical tip, family_fit and official booking_url only when verified. Use 0 for free activities. State age restrictions and booking lead time when relevant, but do not invent either. No hotels, dining or day-by-day schedule.";
 if(kind==="dining")return "You are the DINING SPECIALIST for "+ctx.area.name+". Research restaurants, food markets, local signature dishes and authentic dining experiences in or near this base. "+common+" Return 6 specific, diverse and family-appropriate options: 2 Budget, 2 Mid-range and 2 Luxury. For each include area, cuisine, signature dish, tier (exactly Budget, Mid-range or Luxury), type of meal (street food, food court, casual, special dinner, etc.), indicative adult_price_per_person, child_price_per_person and infant_price_per_person in destination local currency. These values must be per person for one meal, never a whole-family total or a per-day total. Also include price_per_person as the adult per-meal fallback, why visit, and a reservation/official URL only when verified. Include special-occasion and affordable everyday choices. Do not plan activities or hotels.";
 if(kind==="guide")return "You are the TRAVEL PRACTICALITIES, SHOPPING AND BUDGET SPECIALIST. Research passport-dependent entry guidance, weather for travel dates, connectivity, health/safety, money, etiquette and packing. "+(t.includeShopping?"Also research worthwhile shopping areas and items.":"Shopping research is not required; omit shopping recommendations.")+" "+common+" The traveller home currency is exactly "+t.cur+". In budget.home_currency, return exactly "+t.cur+". budget.currency must be the destination local currency ISO code. The application will override exchange_rate_to_home with a daily reference FX rate when available, but still provide a positive indicative fallback rate (home currency units for one local currency unit) in case the reference-rate service is unavailable. For numeric budget: international_flight_per_person and category flight fares = fallback round-trip fares per traveller only when the flight specialist did not return both outbound and return one-way fares; the application derives round-trip fares by adding the selected outbound and return one-way options when both are present; local_transport_total = whole-party transport total; hotel_per_room_per_night = indicative nightly rate for one family room for up to 2 adults + 1 child, with infants sharing only if permitted; activity_per_person_per_day and food_per_person_per_day = fallback daily averages used only when timed itinerary prices are unavailable; shopping_per_person = per-person whole-trip allowance (0 when shopping is excluded); contingency_percent 10-20. Return budget_strategy for the requested style plus budget_strategies with exactly three style-specific guidance records (Budget, Mid-range, Luxury), each with flights, hotels, food, experiences and transport. Include 4-8 concise budget.assumptions explaining airfare, room occupancy, daily meal basis, child/infant fare assumptions and any exclusions. Return 5-8 shopping_guide items only when shopping is included; otherwise return an empty array. For EACH shopping_guide item, include a places array with 3-6 specific real shops, markets, malls or specialist stores where the item/category can be purchased in the stated area or nearby. Each place must have a distinct verified/common public name, area, category, address or mall/market location where known, a concise reason to visit, and price_level (Budget, Mid-range or Luxury). Add website only when a reliable official HTTPS URL is known; otherwise leave it empty. Do not invent exact street addresses, store branches or URLs. If you cannot confidently name specific places, return fewer places and explain the limitation in tip. These are recommended places, not confirmed stock or opening-hour availability. Provide 5-7 family-aware tips and 2-4 caveats. Do not calculate a grand total. Never assert visa eligibility without nationality.";
 if(kind==="day"){
  const list=ctx.highlights.length?ctx.highlights.map(h=>h.name+" — "+h.why_visit).join("; "):"Choose well-known, relevant local experiences.";
  return "You are the DAY PLANNER. Create exactly one realistic, detailed family day for "+ctx.date+" in "+ctx.base+". "+common+" Day number "+ctx.dayNumber+" of "+t.days+"; "+(t.zeroDaysWasted?(ctx.dayNumber===1&&ctx.dayNumber===t.days?"0 days wasted mode on a single-day trip: make the available hours useful, but fit activities only around confirmed/indicative arrival and departure times; if flight times are unknown, keep the plan conservative and clearly state assumptions.":ctx.dayNumber===1?"0 days wasted mode on arrival day: do not write off the day. Use the selected flight's arrival time if available, allow realistic immigration, baggage and airport transfer buffers, then schedule a few nearby, low-effort activities and a meal only in the remaining usable time. Never schedule before arrival or imply the whole day is available.":ctx.dayNumber===t.days?"0 days wasted mode on departure day: do not write off the day. Use the selected return flight's departure time if available, allow check-out, baggage and airport transfer buffers, and schedule a nearby activity and meal only before the safe airport departure time. Never schedule after the flight or compromise airport arrival buffer.":"full sightseeing day: start the day around 08:00-09:00, include breakfast around 08:00 where practical, and schedule the first sightseeing activity or useful transfer no later than 09:00-09:30. Use the morning productively; do not leave 08:00-12:00 empty and do not make lunch the first itinerary item. Schedule lunch around 12:00-13:00, continue with afternoon activities, and include a sensible evening option. This morning-start requirement applies to every normal middle day, including days involving Hong Kong-Macau ferry travel; account for realistic opening hours and transfer time."):(ctx.dayNumber===1?"arrival day: respect arrival/airport transfer and avoid an exhausting schedule.":ctx.dayNumber===t.days?"departure day: allow time for check-out, baggage and airport transfer.":"full sightseeing day: start around 08:00-09:00, include breakfast around 08:00 where practical, schedule the first sightseeing activity or useful transfer by 09:00-09:30, use the morning productively, never leave 08:00-12:00 empty or make lunch the first item, then lunch around 12:00-13:00 and continue through the afternoon with realistic opening hours and travel times."))+" Use these researched attractions as candidate choices: "+list+". Route context: "+ctx.areas.map(a=>a.name+" ("+a.nights+")").join(" → ")+". Return exactly one day with a clear title, useful subtitle, pace, 5-8 chronological activity/transfer entries and 3 timed meal suggestions (breakfast, lunch and dinner where practical), overnight base and whole-party day_estimate. Each activity must include a realistic local time slot, category, duration, transport summary, a short transport_title and detailed transport_details with practical mode/options/transfer guidance where useful, numeric adult_cost_estimate, child_cost_estimate and infant_cost_estimate in local currency (plus cost_estimate as adult fallback), useful practical description, booking_url only if verified, a short child_friendly label and a specific kid_note (comfort, age suitability, restrooms, stroller/nap or safety guidance). Keep kid_note specific rather than generic. "+(t.includeShopping?"Include a shopping stop only if geographically sensible; keep total shopping time to no more than 3 hours in the day and put practical items/market tips in shopping_note.":"Shopping is excluded; do not schedule markets, malls, souvenir stops or shopping breaks and leave shopping_note empty.")+" Group nearby places, include travel/transfer time, leave breaks and do not overfill the day. Meals must include a clear time and separate adult_price_estimate, child_price_estimate and infant_price_estimate (plus price_estimate as adult fallback). Each meal estimate must be per person for that single meal, not a whole-family total or a daily food total. Do not invent extra bases or currency amounts in text. Keep text concise but actionable.";
 }
 return "";
}
function advanceModel(modelState,failedModel){
 const health=modelState.health;
 const current=modelState.models[modelState.index];
 if(current===failedModel&&modelState.index<modelState.models.length-1)modelState.index++;
 while(modelState.index<modelState.models.length&&health?.disabled?.has(modelState.models[modelState.index]))modelState.index++;
 const next=modelState.models[modelState.index];
 return next&&next!==failedModel?next:null;
}
function disableModelForRequest(modelState,model,reason){
 if(!modelState.health) return;
 modelState.health.disabled.add(model);
 modelState.health.reasons.set(model,reason||"temporarily unavailable");
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
async function rankFlightOptionsWithWorkersAI(options,env){
 if(!env?.AI||!env?.QUOTA_DB||!Array.isArray(options)||options.length<2)return {options,used:false};
 const candidates=options.slice(0,40);
 const compact=candidates.map((f,i)=>({id:i,segment:f.segment,airline:f.airlines,flight:f.flight_number,route:f.route,cabin:f.cabin_class,price:f.price_estimate,currency:f.currency||"",duration:f.duration,stops:f.stops,layover:f.layovers||"",departure:f.departure,arrival:f.arrival,baggage:f.baggage||""}));
 try{
  const messages=[
   {role:"system",content:"Rank flight options for a traveller. Return only valid JSON: {\"outbound\":[ids in best-first order],\"return\":[ids in best-first order],\"other\":[ids in best-first order]}. Never invent, alter or remove options. Prefer reasonable total fare, shorter journey, fewer stops and shorter layovers; consider baggage and schedule. Rank each segment separately."},
   {role:"user",content:JSON.stringify(compact)}
  ];
  const guarded=await runWorkersAIWithQuota(env,"@cf/zai-org/glm-4.7-flash",messages,{messages,max_completion_tokens:900,chat_template_kwargs:{enable_thinking:false}},900);
  if(!guarded.allowed)return {options,used:false};
  const result=guarded.result;
  const raw=typeof result?.response==="string"?result.response:typeof result?.result==="string"?result.result:Array.isArray(result?.choices)?result.choices[0]?.message?.content:result?.output_text;
  const parsed=JSON.parse(String(raw||"").replace(/^\s*```(?:json)?/i,"").replace(/```\s*$/,"").trim());
  const ids=[...new Set(["outbound","return","other"].flatMap(k=>Array.isArray(parsed[k])?parsed[k]:[]).filter(i=>Number.isInteger(i)&&i>=0&&i<candidates.length))];
  if(ids.length<2)return {options,used:false};
  const ranked=ids.map(i=>candidates[i]),used=new Set(ids);
  return {options:[...ranked,...candidates.filter((_,i)=>!used.has(i)),...options.slice(40)],used:true};
 }catch(error){console.warn("Workers AI flight ranking unavailable; retaining source order:",error?.message||error);return {options,used:false}}
}
async function runOpenAICompatibleFallback(provider,kind,ctx,env,label){
 const key=provider==="Groq"?env.GROQ_API_KEY:env.OPENROUTER_API_KEY;if(!key)return null;
 const model=provider==="Groq"?"openai/gpt-oss-120b":"openrouter/free";
 const base=provider==="Groq"?"https://api.groq.com/openai/v1/chat/completions":"https://openrouter.ai/api/v1/chat/completions";
 const schema=schemas[kind];if(!schema)return null;
 const task=promptFor(kind,{...ctx,useSearch:false}).replace("GEMINI FLIGHT FARE-RANGE ESTIMATOR","AI FLIGHT FARE-RANGE ESTIMATOR").replace("Gemini reasoning","model reasoning");
 const messages=[{role:"system",content:"Return only valid JSON matching the requested schema. Never fabricate live availability, flight numbers, exact schedules, current fares or citations. Clearly label estimates and uncertainty. Use destination local currency."},{role:"user",content:"Assignment: "+task+"\n\nReturn JSON matching this schema exactly: "+JSON.stringify(schema)}];
 let response;try{response=await fetch(base,{method:"POST",headers:{"authorization":"Bearer "+key,"content-type":"application/json"},body:JSON.stringify({model,messages,temperature:0.2,max_tokens:2400,response_format:{type:"json_object"}}),signal:AbortSignal.timeout(55000)})}catch(e){throw new Error(provider+" connection failed: "+String(e.message||e))}
 if(!response.ok)throw new Error(provider+" returned HTTP "+response.status+". "+(await response.text().catch(function(){return ""})).slice(0,500));
 const payload=await response.json();const raw=payload.choices&&payload.choices[0]&&payload.choices[0].message&&payload.choices[0].message.content;
 const cleaned=String(raw||"").replace(/^\\s*```(?:json)?/i,"").replace(/```\\s*$/,"").trim();if(!cleaned)throw new Error(provider+" returned an empty response.");
 let data;try{data=JSON.parse(cleaned)}catch(e){throw new Error(provider+" returned invalid JSON.")}
 const issue=validateAgent(kind,data,{...ctx,useSearch:false});if(issue)throw new Error(provider+" response failed validation: "+issue);
 return {data:data,sources:[],queries:[],model:provider+" · "+model,status:"completed",fallback:true,grounding:false,provider:provider};
}
async function runExternalAIAgentFallback(kind,ctx,env,label){
 const failures=[];for(const provider of ["Groq","OpenRouter"]){try{const result=await runOpenAICompatibleFallback(provider,kind,ctx,env,label);if(result)return result}catch(error){failures.push(String(error.message||error))}}
 try{const result=await runWorkersAIAgentFallback(kind,ctx,env,label);if(result)return result}catch(error){failures.push(String(error.message||error))}
 throw new Error(label+": Groq, OpenRouter and Workers AI fallbacks unavailable. "+failures.join(" | "));
}
async function runWorkersAIAgentFallback(kind,ctx,env,label){
 const schema=schemas[kind];if(!schema)return null;
 const messages=[{role:"system",content:"Return only valid JSON matching the supplied schema. Never fabricate live availability, flight numbers, exact schedules, current fares or citations. Clearly label uncertainty. Use destination local currency."},{role:"user",content:"Assignment: "+promptFor(kind,{...ctx,useSearch:false}).replace("GEMINI FLIGHT FARE-RANGE ESTIMATOR","AI FLIGHT FARE-RANGE ESTIMATOR").replace("Gemini reasoning","model reasoning")+"\n\nReturn JSON matching this schema exactly: "+JSON.stringify(schema)}];
 const limit=kind==="guide"?2400:(kind==="attractions"||kind==="day"?2800:1800);const guarded=await runWorkersAIWithQuota(env,"@cf/zai-org/glm-4.7-flash",messages,{messages,max_completion_tokens:limit,chat_template_kwargs:{enable_thinking:false}},limit);
 if(!guarded.allowed)throw new Error(label+": Workers AI fallback unavailable ("+String(guarded.reason||"quota or binding unavailable")+")");
 const result=guarded.result;const raw=result.response||result.result||(result.choices&&result.choices[0]&&result.choices[0].message&&result.choices[0].message.content)||result.output_text;
 const cleaned=String(raw||"").replace(/^\\s*```(?:json)?/i,"").replace(/```\\s*$/,"").trim();let data;try{data=JSON.parse(cleaned)}catch(e){throw new Error(label+": Workers AI returned invalid JSON.")}
 const issue=validateAgent(kind,data,{...ctx,useSearch:false});if(issue)throw new Error(label+": Workers AI response failed validation: "+issue);
 return {data:data,sources:[],queries:[],model:"Workers AI · GLM-4.7-Flash fallback",status:"completed",fallback:true,grounding:false,quota:guarded.quota};
}
async function runAgent(kind,ctx,env,send,retryBudget,modelState,requestBudget,requestGate){
 const label=ctx.label||kind,sources=[],queries=[];
 const agentModelState={...modelState,index:0,switched:false,freeTier:modelState.freeTier,searchNoticeSent:false,health:modelState.health};
 const agentDeadline=Date.now()+(Number(ctx.maxDurationMs)||150000);
 const outputLimits={route:1400,flights:2200,transport:1400,stay:2000,attractions:3400,dining:2400,guide:3200,day:4600};
 let maxOutputTokens=outputLimits[kind]||2000,incompleteRetryCount=0;
 let lastModel="",capacityRetriesForModel=0;
 for(let attempt=0;attempt<20;attempt++){
  while(agentModelState.index<agentModelState.models.length&&agentModelState.health?.disabled?.has(agentModelState.models[agentModelState.index]))agentModelState.index++;
  if(agentModelState.index>=agentModelState.models.length){const fallback=await runExternalAIAgentFallback(kind,ctx,env,label);if(fallback)return fallback;throw new Error(label+": all configured Gemini models have been temporarily paused after rate-limit or overload responses from other researchers.");}
  if(Date.now()>=agentDeadline)throw new Error(label+": skipped after reaching its time limit; other saved/researched trip details are retained.");
  await acquireRequestSlot(requestGate);
  if(Date.now()>=agentDeadline){releaseRequestSlot(requestGate);throw new Error(label+": skipped after reaching its time limit; other saved/researched trip details are retained.");}
  const model=agentModelState.models[agentModelState.index];
  if(model!==lastModel){lastModel=model;capacityRetriesForModel=0}
  const modelIsFallback=agentModelState.index>0;
  const useSearch=ctx.useSearch&&!(agentModelState.freeTier&&modelIsFallback);
  if(ctx.useSearch&&!useSearch&&!agentModelState.searchNoticeSent){
   agentModelState.searchNoticeSent=true;
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
    body:JSON.stringify(body),signal:AbortSignal.timeout(Math.max(1000,Math.min(110000,agentDeadline-Date.now())))
   });
  }catch(err){
   releaseRequestSlot(requestGate);
   if(err?.name==="TimeoutError"){
    const next=advanceModel(agentModelState,model);
    if(next){
     agentModelState.switched=true;agentModelState.switched=true;
     send({type:"model_fallback",agent:label,from:model,to:next,freeTier:agentModelState.freeTier,searchDisabled:!!(agentModelState.freeTier&&ctx.useSearch),message:"The current AI model took too long to respond. Switching to "+next+" so this research can continue."});
     continue;
    }
    const fallback=await runExternalAIAgentFallback(kind,ctx,env,label);if(fallback)return fallback;throw new Error(label+": all configured AI models timed out and external fallbacks failed.");
   }
   if(attempt<11&&retryBudget.remaining>0){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"Connection interrupted; retrying once."});continue}
   const fallback=await runExternalAIAgentFallback(kind,ctx,env,label);if(fallback)return fallback;throw new Error(label+": Could not connect to Gemini or fallback providers.");
  }
  if(response.status===429){
   let details="";try{details=(await response.text()).slice(0,700)}catch{}
   releaseRequestSlot(requestGate);
   if(/free.?tier|FreeTier/i.test(details))agentModelState.freeTier=true;
   disableModelForRequest(agentModelState,model,"HTTP 429 rate limit");
   // A rate-limited model is skipped immediately; do not stall every researcher on its cooldown.
   const next=advanceModel(agentModelState,model);
   if(next){agentModelState.switched=true;agentModelState.switched=true;send({type:"model_fallback",agent:label,from:model,to:next,freeTier:agentModelState.freeTier,searchDisabled:!!(agentModelState.freeTier&&ctx.useSearch),message:"Gemini rate-limited "+model+". Skipping it and switching to "+next+"."});continue}
   const fallback=await runWorkersAIAgentFallback(kind,ctx,env,label);if(fallback)return fallback;throw new Error(label+": all configured Gemini models are rate-limited (HTTP 429). "+details);
  }
  if(!response.ok){
   let details="";try{details=(await response.text()).slice(0,700)}catch{}
   releaseRequestSlot(requestGate);
   const transient=[502,503,504].includes(response.status)||isCapacityError(details);
   if(transient){
    disableModelForRequest(agentModelState,model,"HTTP "+response.status+" overload");
    // Do not spend a second long request on a provider already returning 502/503/504.
    const next=advanceModel(agentModelState,model);
    if(next){agentModelState.switched=true;agentModelState.switched=true;send({type:"model_fallback",agent:label,from:model,to:next,freeTier:agentModelState.freeTier,searchDisabled:!!(agentModelState.freeTier&&ctx.useSearch),message:"Model "+model+" is temporarily overloaded (HTTP "+response.status+"). Switching immediately to "+next+"."});continue}
   }
   if(useSearch&&(response.status===400||response.status===403))throw new Error(label+": Gemini rejected the Google Search request (HTTP "+response.status+"). Search grounding may require an eligible billing-enabled project or the provider may have rejected the request configuration. "+details);
   if(transient){const fallback=await runWorkersAIAgentFallback(kind,ctx,env,label);if(fallback)return fallback;throw new Error(label+": all configured Gemini models are currently overloaded or unavailable. Please wait a few minutes and retry. Last response: HTTP "+response.status+". "+details);}
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
   // A broken/aborted stream is a provider failure: switch model before spending another retry on it.
   const next=advanceModel(agentModelState,model);
   if(next){
    agentModelState.switched=true;agentModelState.switched=true;
    send({type:"model_fallback",agent:label,from:model,to:next,freeTier:agentModelState.freeTier,searchDisabled:!!(agentModelState.freeTier&&ctx.useSearch),message:"The response from "+model+" was interrupted. Switching to "+next+" instead of retrying the same model."});
    continue;
   }
   if(canRetry){retryBudget.remaining--;send({type:"agent_retry",agent:label,message:"The response stream was interrupted; retrying once."});continue}
   const fallback=await runWorkersAIAgentFallback(kind,ctx,env,label);if(fallback)return fallback;throw new Error(label+": response stream interrupted: "+(readError?.message||"network error"));
  }
  if(streamError){
   if(isCapacityError(streamError)){
    disableModelForRequest(agentModelState,model,"stream capacity error");
    const next=advanceModel(agentModelState,model);
    if(next){agentModelState.switched=true;agentModelState.switched=true;send({type:"model_fallback",agent:label,from:model,to:next,freeTier:agentModelState.freeTier,searchDisabled:!!(agentModelState.freeTier&&ctx.useSearch),message:"Model "+model+" reported high demand. Switching immediately to "+next+"."});continue}
    const fallback=await runWorkersAIAgentFallback(kind,ctx,env,label);if(fallback)return fallback;throw new Error(label+": all configured Gemini models are currently experiencing high demand. Please retry later. "+streamError);
   }
   throw new Error(label+": "+streamError);
  }
  let data=null,validationIssue="No structured JSON was returned.";
  if(output.trim()){
   try{data=JSON.parse(output.trim());validationIssue=validateAgent(kind,data,ctx)}
   catch{validationIssue="Gemini returned incomplete or invalid JSON."}
  }
  if(kind==="flights"&&ctx.requireVerifiedFlightSearch===true&&data&&(!ctx.useSearch||queries.length===0||sources.length===0)){
   throw new Error(label+": live flight research could not be verified. Search must be enabled and at least one real search query and source are required; generated flight suggestions have been discarded.");
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
    const next=advanceModel(agentModelState,model);
    if(next&&requestBudget.remaining>0&&attempt<19){
     incompleteRetryCount++;
     agentModelState.switched=true;agentModelState.switched=true;
     send({type:"model_fallback",agent:label,from:model,to:next,freeTier:agentModelState.freeTier,searchDisabled:!!(agentModelState.freeTier&&ctx.useSearch),message:"The response remained incomplete after increasing its output limit. Retrying "+label+" with "+next+"."});
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
async function handlePlanPost(context){
 const {request,env}=context;
 try{
  const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return J({error:"Forbidden request."},403);
  if(!env.GEMINI_API_KEY)return J({error:"Server is not configured: GEMINI_API_KEY is missing."},500);
  let b;try{b=await request.json()}catch{return J({error:"Invalid request body."},400)}
  traceEvent(context,"request_parsed","success",{destination:clip(b.dest,120),force_refresh:b.forceRefresh===true,retry_only:!!b.retryOnly});
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
  const trip={dest,d1,d2,days:dayCount,pax,adults,children,infants,childAges,bud:clip(b.bud,20)||"Mid-range",cur:clip(b.cur,5)||"INR",from:clip(b.from,60)||"Mumbai",cabin:clip(b.cabin,30)||"Any",stops:clip(b.stops,20)||"Any",int:clip(b.int,250),includeShopping:b.includeShopping!==false,zeroDaysWasted:b.zeroDaysWasted===true};
  const useSearch=b.useSearch===true;
  const maxBases=Math.min(4,Math.max(1,Math.ceil(Math.max(1,dayCount-1)/2)));
  const cacheInput={trip,useSearch,maxBases};
  const cacheKey=await makeTripCacheKey(cacheInput);
  // Compatibility lookup for reports saved before cabin/stops were added to the cache identity.
  const legacyTrip={...trip};delete legacyTrip.cabin;delete legacyTrip.stops;
  const legacyCacheKey=await makeTripCacheKey({trip:legacyTrip,useSearch,maxBases});
  const forceRefresh=b.forceRefresh===true;
  traceEvent(context,"cache_lookup","started",{force_refresh:forceRefresh});
  let cachedTrip=forceRefresh?null:await readTripReportCache(env,cacheKey);
  let cacheKeyUsed=cachedTrip?cacheKey:null;
  if(!cachedTrip&&!forceRefresh){
   cachedTrip=await readTripReportCache(env,legacyCacheKey);
   if(cachedTrip){cacheKeyUsed=legacyCacheKey;traceEvent(context,"cache_lookup_legacy","success",{matched_legacy_key:true});}
  }
  traceEvent(context,"cache_lookup",cachedTrip?"success":"info",{hit:!!cachedTrip,key_version:cacheKeyUsed===legacyCacheKey?"legacy":"current"});
  const heartbeat=new TextEncoder();
  let cancelled=false,heartbeatTimer=null,deadlineTimer=null;
  const stream=new ReadableStream({
   start(controller){
    const emit=value=>{if(cancelled)return;try{if(value&&typeof value==="object"&&value.type!=="heartbeat"){const stage=value.stage||value.agent||value.type||"stream_event";const status=value.type==="error"?"error":value.type==="agent_retry"||value.type==="model_fallback"?"warning":"info";traceEvent(context,"plan:"+String(stage),status,{type:value.type,message:value.message||value.error,agent:value.agent,from:value.from,to:value.to,freeTier:value.freeTier});}controller.enqueue(heartbeat.encode("data: "+JSON.stringify(value)+"\n\n"))}catch(error){traceEvent(context,"stream_emit","error",{message:error?.message});cancelled=true}};
    emit({type:"progress",stage:"route",message:"Route architect is selecting the best bases and route…",searchEnabled:useSearch});
    heartbeatTimer=setInterval(()=>emit({type:"heartbeat",message:"Travel research is still running; your connection is active."}),10000);
    // An HTTP-triggered Worker has no hard wall-time cap while the client stays connected.
    // This guard bounds one unusually long overall plan without cutting normal multi-agent runs short.
    deadlineTimer=setTimeout(()=>{emit({type:"error",error:"The research team exceeded its 9-minute safety window. Please retry with fewer travel days or a simpler destination."});cancelled=true;controller.close()},540000);
    (async()=>{
     try{
      // 21-day / four-base plans use at most 37 agents. The shared request budget caps model rotations and retries at 49 calls; the gate allows at most two in-flight calls.
      traceEvent(context,"model_configuration","success",{provider:"Gemini",model:clip(env.MODEL||"gemini-3.8-flash",80)});
      const primaryModel=clip(env.MODEL||"gemini-3.8-flash",80);
      const configuredFallback=clip(env.FALLBACK_MODEL||"gemini-3.5-flash-lite",80);
      const tertiaryModel=clip(env.TERTIARY_MODEL||"gemini-3.1-flash-lite",80);
      const modelCandidates=[primaryModel,configuredFallback,tertiaryModel].filter((model,index,list)=>model&&list.indexOf(model)===index);
      const modelState={primary:primaryModel,models:modelCandidates,index:0,switched:false,freeTier:false,searchNoticeSent:false,health:{disabled:new Set(),reasons:new Map()}};
      const retryBudget={remaining:18};
      const requestBudget={remaining:90};
      const requestGate=createRequestGate(2,4000);
      if(b.retryOnly&&cachedTrip?.report){
       const request=b.retryOnly,kind=String(request.kind||""),areaName=clip(request.area,100),date=clip(request.date,10);
       const allowed=["flights","stay","attractions","dining","transport","day"];
       if(!allowed.includes(kind))throw new Error("This section cannot be retried independently.");
       const report=JSON.parse(JSON.stringify(cachedTrip.report));
       report.request_context={trip,useSearch,maxBases};
       const area=report.areas?.find(x=>x.name===areaName);
       const label=kind==="day"?"Day planner · "+date:kind==="transport"?"Transport researcher":kind==="flights"?"Flight researcher":kind+" researcher · "+areaName;
       const ctx={trip,useSearch,areas:report.areas||[],area,label,date,dayNumber:(report.days||[]).findIndex(x=>x.date===date)+1,base:(report.days||[]).find(x=>x.date===date)?.base||""};
       traceEvent(context,"retry_agent:"+kind,"started",{area:areaName,date});
       const result=await runAgent(kind,{...ctx,useSearch:kind==="flights"?true:ctx.useSearch},env,emit,retryBudget,modelState,requestBudget,requestGate);
       traceEvent(context,"retry_agent:"+kind,"success",{model:result.model});
       if(kind==="flights"){const data=result.data;report.flight_options=data.flight_options||[];report.getting_there=data.getting_there||"";}
       else if(kind==="stay"){if(!area)throw new Error("The requested area was not found in the saved report.");area.hotel_options=result.data.hotel_options||[];}
       else if(kind==="attractions"){report.highlights=(report.highlights||[]).filter(x=>String(x.area||"")!==areaName).concat(result.data.highlights||[]);}
       else if(kind==="dining"){report.dining=(report.dining||[]).filter(x=>String(x.area||"")!==areaName).concat(result.data.dining||[]);}
       else if(kind==="transport")report.internal_transport=result.data.internal_transport||[];
       else if(kind==="day"){const index=(report.days||[]).findIndex(x=>x.date===date);if(index<0)throw new Error("The requested day was not found.");report.days[index]=result.data.days[0];}
       report.research_unavailable=(report.research_unavailable||[]).filter(x=>!(x.kind===kind&&(kind==="day"?x.date===date:kind==="transport"||kind==="flights"?true:x.area===areaName)));
       report.research_sources=sourceUnique([...(report.research_sources||[]),...(result.sources||[])]).map(x=>({...x,agent:label}));
       const saved=await writeTripReportCache(env,cacheKey,cacheInput,report);
       report.cache={hit:true,saved,retried:kind,createdAt:new Date().toISOString()};
       emit({type:"result",data:report});return;
      }
      if(cachedTrip?.report){
       emit({type:"stage",stage:"cache",message:"Matching saved itinerary found. Loading the database copy, then refreshing live flight prices for the current dates…",agentTotal:1,cacheHit:true});
       const combined=JSON.parse(JSON.stringify(cachedTrip.report));
       combined.request_context={trip,useSearch,maxBases};
       const cachedFlightCurrency=normaliseFlightCurrency(combined.flight_options,combined.budget?.home_currency||trip.cur,combined.currency_code||combined.budget?.currency,combined.budget?.exchange_rate_to_home);
       if(cachedFlightCurrency.converted)traceEvent(context,"flight_currency_normalisation","success",cachedFlightCurrency);
       combined.research=combined.research||{};
       combined.caveats=Array.isArray(combined.caveats)?combined.caveats:[];
       combined.research_unavailable=Array.isArray(combined.research_unavailable)?combined.research_unavailable:[];
       const flightRefresh={ok:true,cached:true,provider:"Gemini estimate",options:Array.isArray(combined.flight_options)?combined.flight_options.length:0};
       traceEvent(context,"cache_flight_refresh","skipped",{reason:"cached Gemini fare ranges are reused; plan generation never calls SerpApi"});
       combined.cache={hit:true,saved:true,createdAt:cachedTrip.createdAt,flightsRefreshed:false,flightRefresh};
       try{const saved=await writeTripReportCache(env,cacheKey,cacheInput,combined);combined.cache.saved=saved;}catch(saveError){combined.cache.saved=false;traceEvent(context,"cache_flight_refresh_persist","warning",{message:saveError?.message||String(saveError)});}
       emit({type:"result",data:combined,cacheHit:true,cacheCreatedAt:cachedTrip.createdAt,flightsRefreshed:flightRefresh.ok});
       return;
      }
      if(forceRefresh)emit({type:"stage",stage:"cache_refresh",message:"Refreshing all trip research as requested…",agentTotal:0,cacheRefresh:true});
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
       const ctx={trip,useSearch:task.kind==="flights"?true:useSearch,maxBases,nights:dayCount-1,label:task.label};
       const result=await runAgent(task.kind,{...ctx,useSearch:task.kind==="flights"?true:ctx.useSearch},env,emit,retryBudget,modelState,requestBudget,requestGate);
       openingCompleted++;
       emit({type:"agent_completed",agent:task.label,completed:openingCompleted,total:openingTasks.length,sourceCount:result.sources.length,searchCount:result.queries.length});
       return {...task,...result};
      },failure=>emit({type:"agent_failed",agent:failure.task.label,error:failure.error}));
      const openingFailures=openingRuns.filter(x=>!x.ok);
      const criticalOpeningFailures=openingFailures.filter(x=>["route","guide"].includes(x.task.kind));
      if(criticalOpeningFailures.length)throw new Error("Essential trip research could not complete: "+criticalOpeningFailures.map(x=>x.task.label+" — "+x.error).join("; "));
      const openingResults=openingRuns.filter(x=>x.ok).map(x=>x.value);
      const researchWarnings=openingFailures.map(x=>x.task.label+" could not complete: "+x.error);
      const unavailable=openingFailures.map(x=>({kind:x.task.kind,label:x.task.label,error:x.error}));
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
      const specialistRuns=await pool(tasks,3,async(task)=>{
       emit({type:"agent_started",agent:task.label,completed,total:tasks.length});
       const ctx={trip,useSearch,areas,area:task.area,label:task.label};
       const result=await runAgent(task.kind,ctx,env,emit,retryBudget,modelState,requestBudget,requestGate);
       completed++;
       emit({type:"agent_completed",agent:task.label,completed,total:tasks.length,sourceCount:result.sources.length,searchCount:result.queries.length});
       return {...task,...result};
      },failure=>emit({type:"agent_failed",agent:failure.task.label,error:failure.error}));
      const specialistFailures=specialistRuns.filter(x=>!x.ok);
      researchWarnings.push(...specialistFailures.map(x=>x.task.label+" could not complete: "+x.error));
      unavailable.push(...specialistFailures.map(x=>({kind:x.task.kind,area:x.task.area?.name||"",label:x.task.label,error:x.error})));
      const specialistResults=[...openingResults.filter(x=>x.kind!=="route"),...specialistRuns.filter(x=>x.ok).map(x=>x.value)];
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
      if(researchWarnings.length){
       combined.research_warnings=researchWarnings;
       combined.caveats=Array.isArray(combined.caveats)?combined.caveats:[];
       combined.caveats.push("Some optional research sections could not be completed because a research provider was temporarily overloaded. Missing sections are left blank rather than invented.");
       emit({type:"agent_notice",message:"The main itinerary is continuing. "+researchWarnings.length+" optional research section(s) could not be completed and will be clearly marked."});
      }
      const localCurrency=String(route.data.currency_code||guide.budget.currency||"").toUpperCase();
      const homeCurrency=String(trip.cur||"INR").toUpperCase();
      const fxRate=await fxRatePromise;
      const flightResearch=specialistResults.find(x=>x.kind==="flights")?.data;
       const flightCurrencyNormalisation=normaliseFlightCurrency(flightResearch?.flight_options,homeCurrency,localCurrency,fxRate?.rate);
       if(flightCurrencyNormalisation.converted)traceEvent(context,"flight_currency_normalisation","success",flightCurrencyNormalisation);
      const flightRun=openingRuns.find(x=>x.ok&&x.value?.kind==="flights");
      if(!flightRun?.ok||!flightResearch?.flight_options?.length){
       combined.flight_options=[];
       guide.budget.international_flight_per_person=0;
       guide.budget.international_flight_adult=0;
       guide.budget.international_flight_child=0;
       guide.budget.international_flight_infant=0;
       guide.caveats=Array.isArray(guide.caveats)?guide.caveats:[];
       guide.caveats.push("Live flight research was unavailable or could not be verified. Flight costs are excluded from the estimate until real fares are added.");
       combined.research=combined.research||{};
       combined.research.flight_search_status="unavailable";
       combined.research.flight_search_requested=true;
       combined.research.flight_search_executed=false;
       combined.research.flight_verified_result_count=0;
       combined.research.flight_failure_reason=flightRun?.error||"No verified flight options returned.";
      }else{
       combined.research=combined.research||{};
       combined.research.flight_search_status="completed";
       combined.research.flight_search_requested=true;
       combined.research.flight_search_executed=true;
       combined.research.flight_verified_result_count=flightResearch.flight_options.length;
      }
      if(flightResearch?.flight_options?.length)combined.flight_options=flightResearch.flight_options;
      const fareScaleCheck=validateFlightFareScale(flightResearch,guide.budget,fxRate,homeCurrency);
      if(fareScaleCheck.invalid){
       guide.caveats=Array.isArray(guide.caveats)?guide.caveats:[];
       guide.caveats.push(fareScaleCheck.invalid+" flight fare option(s) exceeded the generous "+homeCurrency+" "+fareScaleCheck.maxOneWayHome.toLocaleString("en-US")+" cabin-adjusted one-way sanity ceiling. Unverified flight fares have been excluded from the cards and trip total; the total will be understated until you verify and enter real fares.");
       if(!fareScaleCheck.roundTripUsable){
        guide.budget.international_flight_per_person=0;
        guide.budget.international_flight_adult=0;
        guide.budget.international_flight_child=0;
        guide.budget.international_flight_infant=0;
       }
       emit({type:"model_notice",message:"One or more flight estimates failed the currency-scale check. Unverified fares have been excluded rather than inflating the trip budget."});
      }
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
      const dayRuns=await pool(dayTasks,3,async(task)=>{
       const relevant=combined.highlights.filter(h=>String(h.area||"").toLowerCase().includes(task.base.toLowerCase())||task.base.toLowerCase().includes(String(h.area||"").toLowerCase())).slice(0,8);
       emit({type:"agent_started",agent:task.label,completed:daysCompleted,total:dayCount});
       const result=await runAgent("day",{trip,useSearch:false,label:task.label,date:task.date,dayNumber:task.index+1,base:task.base,areas,highlights:relevant},env,emit,retryBudget,modelState,requestBudget,requestGate);
       daysCompleted++;
       emit({type:"agent_completed",agent:task.label,completed:daysCompleted,total:dayCount,sourceCount:result.sources.length,searchCount:0});
       return {day:result.data.days[0],model:result.model};
      },failure=>emit({type:"agent_failed",agent:failure.task.label,error:failure.error}));
      const dayFailures=dayRuns.filter(x=>!x.ok);
      unavailable.push(...dayFailures.map(x=>({kind:"day",date:x.task.date,base:x.task.base,label:x.task.label,error:x.error})));
      const dayResults=dayRuns.filter(x=>x.ok).map(x=>x.value);
      const dayByDate=new Map(dayResults.map(x=>[x.day.date,x.day]));
      combined.days=dayDates.map((date,index)=>dayByDate.get(date)||({date,base:schedule[index],title:"Daily plan temporarily unavailable",subtitle:"This day could not be researched because the source was busy.",pace:"",activities:[],meals:[],overnight:schedule[index],day_estimate:0}));
      const allResearch=[{label:"Route architect",sources:route.sources||[],queries:route.queries||[]},...specialistResults];
      combined.research_sources=sourceUnique(allResearch.flatMap(x=>x.sources||[])).map(s=>({...s,agent:allResearch.find(x=>(x.sources||[]).some(a=>a.url===s.url))?.label||"Researcher"}));
      const modelsUsed=Array.from(new Set([route.model,...specialistResults.map(x=>x.model),...dayResults.map(x=>x.model)].filter(Boolean)));
      combined.research={search_requested:useSearch,search_enabled:useSearch&&!(modelState.freeTier&&modelState.switched),search_disabled_for_free_tier_fallback:modelState.freeTier&&modelState.switched&&useSearch,primary_model:modelState.primary,fallback_models:modelState.models.slice(1),model_fallback_used:modelState.switched,model_used:modelsUsed.length===1?modelsUsed[0]:modelsUsed.join(", "),models_used:modelsUsed,agents_completed:specialistResults.length+dayResults.length+1,web_sources:combined.research_sources.length,search_queries:allResearch.reduce((sum,x)=>sum+x.queries.length,0)};
      combined.research.flight_search_requested=true;
      combined.research.flight_search_executed=!!flightRun?.ok;
      combined.research.flight_search_status=flightRun?.ok&&combined.flight_options.length?"completed":"unavailable";
      combined.research.flight_search_provider=flightResearch?.flight_options?.length?(flightResearch.flight_options[0].price_source||"Google Flights provider"):"";
      combined.research.flight_verified_result_count=combined.flight_options.length;
      if(!flightRun?.ok)combined.research.flight_failure_reason=flightRun?.error||"Live flight provider search failed.";
      const required=["flight_options","internal_transport","areas","highlights","dining","days","tips","caveats","shopping_guide"];
      if(required.some(k=>!Array.isArray(combined[k]))||combined.days.length!==dayCount||!combined.budget||!combined.practical)throw new Error("The completed itinerary failed final completeness checks.");
      combined.research_unavailable=unavailable;
      if(unavailable.length){
       combined.research_warnings=researchWarnings;
       combined.caveats=Array.isArray(combined.caveats)?combined.caveats:[];
       combined.caveats.push("Some sections are temporarily unavailable. Use the section-specific Try again controls to refresh only those results.");
       emit({type:"agent_notice",message:unavailable.length+" section(s) are temporarily unavailable. The rest of your trip research is ready."});
      }
      combined.request_context={trip,useSearch,maxBases};
      const cacheReport=JSON.parse(JSON.stringify(combined));
      // Keep provider-verified flight options in the saved report for identical future searches.
      const cacheSaved=await writeTripReportCache(env,cacheKey,cacheInput,cacheReport);
      combined.cache={hit:false,saved:cacheSaved,flightsRefreshed:!!flightRun?.ok&&combined.flight_options.length>0,refreshed:forceRefresh};
      emit({type:"result",data:combined,cacheHit:false,cacheSaved});
     }catch(err){
      traceEvent(context,"agent_orchestration","error",{message:err?.message,stack:String(err?.stack||"").slice(0,3000)});
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

export async function onRequestPost(context){return withTransactionLog(context,"plan",()=>handlePlanPost(context));}
