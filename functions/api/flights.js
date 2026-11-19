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
export async function onRequestPost({request,env}){
 try{
  const origin=request.headers.get("origin");
  if(origin&&origin!==new URL(request.url).origin)return json({error:"Forbidden request."},403);
  let b;try{b=await request.json()}catch{return json({error:"Invalid request body."},400)}
  const key=env.SERPAPI_API_KEY||env.SERP_API_KEY;
  if(!key)return json({error:"Flight price search is not configured. Add SERPAPI_API_KEY as a Cloudflare Pages secret."},503);
  const action=clip(b.action,20);
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
  const from=clip(b.origin,3).toUpperCase(),to=clip(b.destination,3).toUpperCase();
  if(!/^[A-Z]{3}$/.test(from)||!/^[A-Z]{3}$/.test(to)||from===to)return json({error:"Choose valid airport suggestions for both origin and destination."},400);
  if(!dateOk(b.departureDate)||!dateOk(b.returnDate)||b.returnDate<b.departureDate)return json({error:"Enter valid outbound and return dates."},400);
  const currency=clip(b.currency,3).toUpperCase()||"INR";
  if(!/^[A-Z]{3}$/.test(currency))return json({error:"Choose a valid trip currency."},400);
  const legs=[{segment:"outbound",from,to,date:b.departureDate},{segment:"return",from:to,to:from,date:b.returnDate}];
  // Four cabin classes × two one-way directions = eight Google Flights searches.
  // Stops are returned together and filtered in TripPlanner, so changing the stop filter costs no extra search.
  const jobs=[];
  for(const cabin of CABINS)for(const leg of legs){
   jobs.push((async()=>{
    const result=await serpSearch({
     engine:"google_flights",departure_id:leg.from,arrival_id:leg.to,outbound_date:leg.date,type:"2",
     travel_class:cabin.value,currency,gl:"in",hl:"en",adults:"1",stops:"0",sort_by:"2",show_hidden:"true"
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
   return json({code:"QUOTA_EXCEEDED",error:"SerpApi search quota or rate limit has been reached. TripPlanner should use its original itinerary flight estimates instead."},429);
  }
  if(!options.length)return json({error:errors[0]||"Google Flights did not return fares for this route and date. Try another date."},502);
  const seen=new Set(),unique=[];
  for(const option of options){
   const signature=[option.segment,option.cabin_class,option.flight_number,option.departure,option.arrival,option.price_estimate].join("|");
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