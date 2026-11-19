// Cloudflare Pages Function: POST /api/flights
// Indicative flight-price search via Google Flights results through SerpApi.
// This endpoint is search-only: it never requests booking tokens or creates bookings.
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const clip=(v,n=120)=>String(v??"").trim().slice(0,n);
const dateOk=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||""))&&Number.isFinite(Date.parse(v+"T00:00:00Z"));
const CABINS=[{key:"economy",value:1,label:"Economy"},{key:"premium_economy",value:2,label:"Premium Economy"},{key:"business",value:3,label:"Business"},{key:"first",value:4,label:"First Class"}];
function quotaExceeded(message,status=0){
 return status===429||/quota|limit (?:has been )?reached|monthly searches|searches (?:are )?exhausted|run out of searches|out of searches|no searches remaining/i.test(String(message||""));
}
async function serpSearch(params,key){
 const url=new URL("https://serpapi.com/search.json");
 for(const [k,v] of Object.entries({...params,api_key:key}))if(v!==undefined&&v!==null&&v!=="")url.searchParams.set(k,String(v));
 const response=await fetch(url,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(45000)});
 const body=await response.json().catch(()=>({}));
 if(!response.ok||body.error){
  const message=body.error||"SerpApi request failed ("+response.status+").";
  const error=new Error(message);error.status=response.status;error.quotaExceeded=quotaExceeded(message,response.status);throw error;
 }
 if(body.search_metadata?.status==="Error"){
  const message=body.error||"Google Flights search returned an error.";
  const error=new Error(message);error.quotaExceeded=quotaExceeded(message);throw error;
 }
 return body;
}
function formatTime(value){
 if(!value)return "";
 const m=String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
 if(!m)return String(value);
 const months=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
 return Number(m[3]).toString().padStart(2,"0")+" "+months[Number(m[2])-1]+" · "+m[4]+":"+m[5];
}
function duration(minutes){
 const n=Number(minutes);if(!Number.isFinite(n)||n<=0)return "";
 return Math.floor(n/60)+"h "+String(n%60).padStart(2,"0")+"m";
}
async function resolveAirport(value,key){
 const text=clip(value,100);
 if(/^[A-Z]{3}$/i.test(text))return text.toUpperCase();
 const result=await serpSearch({engine:"google_flights_autocomplete",q:text,hl:"en",gl:"in",exclude_regions:"true"},key);
 const airports=(result.suggestions||[]).flatMap(suggestion=>(suggestion.airports||[]).map(airport=>({id:airport.id,name:airport.name,city:airport.city||suggestion.name}))).filter(x=>/^[A-Z]{3}$/.test(String(x.id||"")));
 if(!airports.length)throw new Error("Could not identify an airport for "+text+". Choose a more specific city or airport.");
 return airports[0];
}
function mapFlight(item,segment,cabin,currency,sourceUrl){
 const legs=Array.isArray(item.flights)?item.flights:[];
 const price=Number(item.price);
 if(!legs.length||!Number.isFinite(price)||price<=0)return null;
 const first=legs[0],last=legs[legs.length-1];
 const airlines=[...new Set(legs.map(x=>x.airline).filter(Boolean))];
 const numbers=legs.map(x=>x.flight_number).filter(Boolean);
 const route=legs.map(x=>(x.departure_airport?.id||"")+"–"+(x.arrival_airport?.id||"")).join(" · ");
 const layovers=Array.isArray(item.layovers)?item.layovers:[];
 const stopCount=Math.max(0,legs.length-1);
 const layoverText=layovers.map(x=>(x.id||x.name||"Layover")+(x.duration?" ("+duration(x.duration)+")":"")).join(" · ");
 const features=[...(item.extensions||[]),...legs.flatMap(x=>x.extensions||[])];
 return {
  segment,airlines:airlines.join(" / ")||"Airline not specified",cabin_class:cabin,
  route,flight_number:numbers.join(" + "),
  departure:formatTime(first.departure_airport?.time),arrival:formatTime(last.arrival_airport?.time),
  duration:duration(item.total_duration||legs.reduce((n,x)=>n+(Number(x.duration)||0),0)),
  stops:String(stopCount),layovers:layoverText,
  baggage:features.filter(x=>/baggage|carry.?on|checked bag/i.test(String(x))).slice(0,3).join(" · "),
  price_estimate:price,adult_price_per_person:price,child_price_per_person:price,infant_price_per_person:price*.1,
  provider_total_amount:price,provider_currency:currency,price_unverified:false,live_fare:true,
  fare_notes:"Indicative Google Flights price for one adult, one-way. Child fares are estimated at the adult fare and lap infants at 10% for trip-budget planning; the provider does not supply a passenger-type breakdown here.",
  source_url:sourceUrl||"",price_source:"Google Flights via SerpApi",price_checked_at:new Date().toISOString()
 };
}

async function fallbackRequest(url,headers){
 const r=await fetch(url,{headers:{Accept:"application/json",...headers},signal:AbortSignal.timeout(45000)}),j=await r.json().catch(()=>({}));
 if(!r.ok||j.status===false||j.error||j.success===false)throw new Error(j.message||j.error?.message||j.description||("HTTP "+r.status));return j;
}
function mapFallback(x,segment,cabin,currency,source){
 const legs=Array.isArray(x.legs)?x.legs:Array.isArray(x.flights)?x.flights:[],a=legs[0]||x,z=legs[legs.length-1]||x,price=Number(x.price?.amount??x.price??x.price_estimate??x.total_price);
 if(!(price>0))return null;
 const airline=x.airline_name||x.airline||(Array.isArray(x.airlines)?x.airlines.join(" / "):"")||legs.map(v=>v.airline_name||v.airline).filter(Boolean).join(" / ")||"Airline not specified";
 const dep=a.departure_time||a.departure_airport?.time||x.departure_time||x.departure,arr=z.arrival_time||z.arrival_airport?.time||x.arrival_time||x.arrival;
 const route=legs.map(v=>(v.departure_airport?.code||v.departure_airport?.id||v.departure_airport||v.from_airport||"")+"–"+(v.arrival_airport?.code||v.arrival_airport?.id||v.arrival_airport||v.to_airport||"")).join(" · ");
 const mins=Number(x.total_duration_minutes??x.total_duration??a.duration_minutes??a.duration);
 return {segment,airlines:airline,cabin_class:cabin,route,flight_number:legs.map(v=>v.flight_number).filter(Boolean).join(" + ")||x.flight_number||"",departure:formatTime(dep),arrival:formatTime(arr),duration:duration(mins),stops:String(x.stops??Math.max(0,legs.length-1)),layovers:(x.layovers||[]).map(v=>v.name||v.id||v).join(" · "),baggage:"",price_estimate:price,adult_price_per_person:price,child_price_per_person:price,infant_price_per_person:price*.1,provider_total_amount:price,provider_currency:x.currency||currency,price_unverified:false,live_fare:true,fare_notes:"Indicative provider fare for one adult, one-way. Child and lap-infant amounts are planning estimates.",source_url:"",price_source:source,price_checked_at:new Date().toISOString()};
}

function extractAirportCode(payload){
 const d=payload.data??payload,items=[...(Array.isArray(d)?d:[]),...(d.airports||[]),...(d.suggestions||[]),...(d.results||[])];
 for(const item of items){const nested=item.airports||[item];for(const a of (Array.isArray(nested)?nested:[nested])){const code=a.id||a.iata_code||a.code||a.airport_code;if(/^[A-Z]{3}$/i.test(String(code||"")))return String(code).toUpperCase()}}
 return "";
}
async function resolveFallbackAirport(value,rapidKey,perceptKey){
 const q=clip(value,100);if(/^[A-Z]{3}$/i.test(q))return q.toUpperCase();
 if(rapidKey){try{const u=new URL("https://google-flights2.p.rapidapi.com/api/v1/searchAirport");u.searchParams.set("query",q);const j=await fallbackRequest(u,{"X-RapidAPI-Key":rapidKey,"X-RapidAPI-Host":"google-flights2.p.rapidapi.com"});const code=extractAirportCode(j);if(code)return code}catch{}}
 if(perceptKey){try{const u=new URL("https://api.perceptlayer.com/v1/google-flights/autocomplete");u.searchParams.set("q",q);u.searchParams.set("hl","en");u.searchParams.set("gl","in");const j=await fallbackRequest(u,{"X-API-Key":perceptKey});const code=extractAirportCode(j);if(code)return code}catch{}}
 throw Error("Could not resolve airport "+q+". Enter a three-letter IATA code such as BOM, DEL or SIN.");
}

async function runRapidFallback(key,from,to,b,currency){
 const rows=[];for(const c of CABINS)for(const l of [{segment:"outbound",from,to,date:b.departureDate},{segment:"return",from:to,to:from,date:b.returnDate}]){
  const u=new URL("https://google-flights2.p.rapidapi.com/api/v1/searchFlights");
  for(const [k,v] of Object.entries({departure_id:l.from,arrival_id:l.to,outbound_date:l.date,travel_class:c.label.toUpperCase().replace(/ /g,"_"),adults:1,currency,language_code:"en-US",country_code:"IN",search_type:"best"}))u.searchParams.set(k,String(v));
  const j=await fallbackRequest(u,{"X-RapidAPI-Key":key,"X-RapidAPI-Host":"google-flights2.p.rapidapi.com"}),d=j.data||j,it=d.itineraries||d;
  rows.push(...[...(it.topFlights||[]),...(it.otherFlights||[]),...(d.flights||[]),...(d.best_flights||[]),...(d.other_flights||[])].map(x=>mapFallback(x,l.segment,c.label,currency,"Google Flights via DataCrawler / RapidAPI")).filter(Boolean));
 }if(!rows.length)throw Error("No usable fares returned");return rows;
}
async function runPerceptFallback(key,from,to,b,currency){
 const rows=[];for(const c of CABINS)for(const l of [{segment:"outbound",from,to,date:b.departureDate},{segment:"return",from:to,to:from,date:b.returnDate}]){
  const u=new URL("https://api.perceptlayer.com/v1/google-flights/one-way");
  for(const [k,v] of Object.entries({origin:l.from,destination:l.to,departure_date:l.date,adults:1,cabin_class:c.key,currency,hl:"en",gl:"in"}))u.searchParams.set(k,String(v));
  const j=await fallbackRequest(u,{"X-API-Key":key});rows.push(...(j.flights||[]).map(x=>mapFallback(x,l.segment,c.label,currency,"Google Flights via Perceptlayer")).filter(Boolean));
 }if(!rows.length)throw Error("No usable fares returned");return rows;
}
function sortFallback(rows){const seen=new Set();return rows.filter(x=>{const k=[x.segment,x.cabin_class,x.route,x.flight_number].join("|").toLowerCase().replace(/\s+/g,"");if(seen.has(k))return false;seen.add(k);return true}).sort((a,b)=>a.price_estimate-b.price_estimate).slice(0,160)}

export async function onRequestPost({request,env}){
 try{
  const origin=request.headers.get("origin");
  if(origin&&origin!==new URL(request.url).origin)return json({error:"Forbidden request."},403);
  let b;try{b=await request.json()}catch{return json({error:"Invalid request body."},400)}
  const key=env.SERPAPI_API_KEY||env.SERP_API_KEY;
  const rapidKey=env.RAPIDAPI_KEY;
  const perceptKey=env.PERCEPTLAYER_API_KEY;
  const action=clip(b.action,20);
  if(action==="status"){
   if(!key)return json({configured:false,provider:"SerpApi",message:"SERPAPI_API_KEY is not configured in Cloudflare Pages."});
   try{
    const accountUrl=new URL("https://serpapi.com/account.json");accountUrl.searchParams.set("api_key",key);
    const response=await fetch(accountUrl,{headers:{Accept:"application/json"},signal:AbortSignal.timeout(12000)});
    const account=await response.json().catch(()=>({}));
    if(!response.ok||account.error)return json({configured:true,valid:false,provider:"SerpApi",message:account.error||"SerpApi account check failed."});
    return json({configured:true,valid:true,provider:"SerpApi",plan:account.plan_name||"Plan",monthlyLimit:Number(account.searches_per_month)||0,used:Number(account.this_month_usage)||0,remaining:Number(account.plan_searches_left??account.total_searches_left)||0,hourlyLimit:Number(account.account_rate_limit_per_hour)||0,hourlyUsed:Number(account.this_hour_searches??account.last_hour_searches)||0,renewalDate:account.plan_renewal_date||null});
   }catch(error){return json({configured:true,valid:null,provider:"SerpApi",message:"Could not read account quota: "+(error.message||"network error")})}
  }
  if(!key&&!rapidKey&&!perceptKey)return json({error:"No flight providers are configured. Add the provider keys as Cloudflare Pages secrets."},503);
  if(action==="places"){
   const q=clip(b.query,80);if(q.length<2)return json({places:[]});
   const result=await serpSearch({engine:"google_flights_autocomplete",q,hl:"en",gl:"in",exclude_regions:"true"},key);
   const places=[];
   for(const suggestion of result.suggestions||[]){
    for(const airport of suggestion.airports||[]){
     if(!airport.id)continue;
     places.push({name:airport.name,city_name:airport.city||suggestion.name,iata_code:airport.id,label:[airport.name,airport.city||suggestion.name,airport.id].filter(Boolean).join(" · ")+" ("+airport.id+")"});
    }
   }
   return json({places:places.slice(0,12)});
  }
  if(action!=="search")return json({error:"Unsupported flight action."},400);
  if(!b.origin||!b.destination)return json({error:"Origin and destination are required."},400);
  if(!dateOk(b.departureDate)||!dateOk(b.returnDate)||b.returnDate<b.departureDate)return json({error:"Enter valid outbound and return dates."},400);
  const currency=clip(b.currency,3).toUpperCase()||"INR";
  let from,to;
  try{const resolve=async value=>{if(key){try{const r=await resolveAirport(value,key);return typeof r==="string"?r:r.id}catch{}}return resolveFallbackAirport(value,rapidKey,perceptKey)};const resolved=await Promise.all([resolve(b.origin),resolve(b.destination)]);from=resolved[0];to=resolved[1];}
  catch(error){return json({error:error.message||"Could not resolve the departure and destination airports."},422)}
  if(from===to)return json({error:"Origin and destination resolve to the same airport."},400);
  if(!/^[A-Z]{3}$/.test(currency))return json({error:"Choose a valid trip currency."},400);
  const legs=[{segment:"outbound",from,to,date:b.departureDate},{segment:"return",from:to,to:from,date:b.returnDate}];
  // Four cabin classes × two one-way directions = eight Google Flights searches.
  // Stops are returned together and filtered in TripPlanner, so changing the stop filter costs no extra search.
  const jobs=[];
  for(const cabin of CABINS)for(const leg of legs){
   jobs.push((async()=>{
    const result=await serpSearch({
     engine:"google_flights",departure_id:leg.from,arrival_id:leg.to,outbound_date:leg.date,type:"2",
     travel_class:cabin.value,currency,gl:"in",hl:"en",adults:"1",sort_by:"2",show_hidden:"true"
    },key);
    const sourceUrl=result.search_metadata?.google_flights_url||"";
    const candidates=[...(result.best_flights||[]),...(result.other_flights||[])];
    const mapped=candidates.map(item=>mapFlight(item,leg.segment,cabin.label,currency,sourceUrl)).filter(Boolean);
    return mapped;
   })());
  }
  const settled=await Promise.allSettled(jobs),options=[],errors=[];
  for(const result of settled){
   if(result.status==="fulfilled")options.push(...result.value);
   else errors.push(String(result.reason?.message||result.reason));
  }
  if(settled.some(result=>result.status==="rejected"&&result.reason?.quotaExceeded)||errors.some(message=>quotaExceeded(message))){
   const providerErrors=["SerpApi quota or rate limit exhausted."];
   if(rapidKey){try{const rows=await runRapidFallback(rapidKey,from,to,b,currency);return json({source:"Google Flights via DataCrawler / RapidAPI",provider:"DataCrawler",searchedAt:new Date().toISOString(),origin:from,destination:to,currency,options:sortFallback(rows),searchesUsed:8,partial:false,errors:[],notice:"Fallback live fares via DataCrawler / RapidAPI. Prices can change. No booking or payment is performed."})}catch(e){providerErrors.push("DataCrawler: "+(e.message||"unavailable"))}}else providerErrors.push("RAPIDAPI_KEY not configured.");
   if(perceptKey){try{const rows=await runPerceptFallback(perceptKey,from,to,b,currency);return json({source:"Google Flights via Perceptlayer",provider:"Perceptlayer",searchedAt:new Date().toISOString(),origin:from,destination:to,currency,options:sortFallback(rows),searchesUsed:8,partial:false,errors:[],notice:"Fallback live fares via Perceptlayer. Prices can change. No booking or payment is performed."})}catch(e){providerErrors.push("Perceptlayer: "+(e.message||"unavailable"))}}else providerErrors.push("PERCEPTLAYER_API_KEY not configured.");
   return json({code:"ALL_PROVIDERS_EXHAUSTED",error:"All live flight providers are unavailable or out of quota. Use the original AI-generated flight estimates.",providerErrors},429);
  }
  if(!options.length)return json({error:errors[0]||"Google Flights did not return fares for this route and date. Try another date."},502);
  const seen=new Set(),unique=[];
  for(const option of options){
   // A flight-number sequence on the same route/date/cabin is one itinerary.
   // SerpApi can repeat it across best_flights/other_flights and cabin result pages.
   const signature=[option.segment,option.cabin_class,option.route,option.flight_number].join("|").toLowerCase().replace(/\s+/g,"");
   if(seen.has(signature))continue;seen.add(signature);unique.push(option);
  }
  unique.sort((a,b)=>a.price_estimate-b.price_estimate);
  return json({
   source:"Google Flights via SerpApi",searchedAt:new Date().toISOString(),origin:from,destination:to,currency,
   options:unique.slice(0,160),searchesUsed:8,partial:errors.length>0,errors:errors.slice(0,2),
   notice:"Indicative Google Flights prices only. Prices and availability can change. No booking, ticketing or payment is performed. Child and infant budget amounts are estimates."
  });
 }catch(error){
  console.error("Google Flights price search failed:",error);
  return json({error:error?.message||"Flight price search failed."},502);
 }
}