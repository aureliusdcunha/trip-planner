// Cloudflare Pages Function: POST /api/flights
// Live flight offers and airport/city lookup via Duffel. The access token is server-side only.
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const clip=(v,n=120)=>String(v??"").trim().slice(0,n);
const dateOk=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||""))&&Number.isFinite(Date.parse(v+"T00:00:00Z"));
async function duffel(path,token,init={}){
 const response=await fetch("https://api.duffel.com"+path,{...init,headers:{"Accept":"application/json","Content-Type":"application/json","Duffel-Version":"v2","Authorization":"Bearer "+token,...(init.headers||{})},signal:AbortSignal.timeout(65000)});
 const body=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(body?.errors?.[0]?.message||body?.errors?.[0]?.title||"Duffel request failed ("+response.status+").");
 return body;
}
function passengersFrom(body){
 const pax=[];
 const adults=Math.max(1,Math.min(12,Number(body.adults)||1));
 const children=Math.max(0,Math.min(12,Number(body.children)||0));
 const infants=Math.max(0,Math.min(12,Number(body.infants)||0));
 const ages=Array.isArray(body.childAges)?body.childAges:[];
 if(infants>adults||adults+children+infants>12)throw new Error("Passenger count is invalid. Infants cannot exceed adults and the total cannot exceed 12.");
 if(ages.length&&ages.length!==children)throw new Error("Enter one age for each child before searching live fares.");
 for(let i=0;i<adults;i++)pax.push({type:"adult"});
 for(let i=0;i<children;i++){const age=Number(ages[i]);if(!Number.isInteger(age)||age<2||age>17)throw new Error("Each child age must be between 2 and 17.");pax.push({age});}
 for(let i=0;i<infants;i++)pax.push({age:1});
 return pax;
}
function isoDuration(v){const m=String(v||"").match(/PT(?:(\d+)H)?(?:(\d+)M)?/);return m?[(m[1]?m[1]+"h":""),(m[2]?m[2]+"m":"")].filter(Boolean).join(" "):String(v||"");}
function mapOffer(offer,segment,cabin,paxCount){
 const slice=(offer.slices||[])[0];if(!slice)return null;
 const legs=slice.segments||[];if(!legs.length)return null;
 const first=legs[0],last=legs[legs.length-1],carriers=[...new Set(legs.map(x=>x.operating_carrier?.name||x.marketing_carrier?.name).filter(Boolean))];
 const flightNumbers=legs.map(x=>(x.marketing_carrier?.iata_code||"")+(x.marketing_carrier_flight_number||"")).filter(Boolean);
 const stops=Math.max(0,legs.length-1),total=Number(offer.total_amount);
 if(!(total>0)||!offer.total_currency)return null;
 const departure=first.departing_at||"",arrival=last.arriving_at||"";
 return {segment,airlines:carriers.join(" / ")||"Airline not supplied",cabin_class:cabin,route:legs.map(x=>(x.origin?.iata_code||"")+"–"+(x.destination?.iata_code||"")).join(" · "),flight_number:flightNumbers.join(" + "),departure:departure?new Date(departure).toLocaleString("en-GB",{timeZone:"UTC",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:false})+" UTC":"",arrival:arrival?new Date(arrival).toLocaleString("en-GB",{timeZone:"UTC",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:false})+" UTC":"",duration:isoDuration(slice.duration),stops:String(stops),baggage:(offer.conditions?.change_before_departure?.allowed?"Changes permitted":"Check change/refund conditions"),provider_total_amount:total,provider_currency:offer.total_currency,provider_offer_id:offer.id,provider_expires_at:offer.expires_at||null,provider_live_mode:offer.live_mode===true,price_unverified:false,live_fare:true,pax_count:paxCount,fare_notes:"Live Duffel offer total for all "+paxCount+" travellers: "+offer.total_currency+" "+total.toFixed(2)+". Per-traveller budget estimate is an average of the whole-party total; individual passenger fares may differ.",booking_advice:"Live search result, not a ticket or booking. Recheck the offer and final total before purchase."};
}
export async function onRequestPost({request,env}){
 try{
  const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)return json({error:"Forbidden request."},403);
  let b;try{b=await request.json()}catch{return json({error:"Invalid request body."},400)}
  const action=clip(b.action,20);
  const token=env.DUFFEL_ACCESS_TOKEN||env.DUFFEL_API_TOKEN;
  if(!token)return json({error:"Live flight search is not configured yet. Add DUFFEL_ACCESS_TOKEN as a Cloudflare Pages secret."},503);
  if(action==="places"){
   const q=clip(b.query,80);if(q.length<2)return json({places:[]});
   const result=await duffel("/places/suggestions?query="+encodeURIComponent(q),token);
   return json({places:(result.data||[]).slice(0,8).map(p=>({name:p.name,city_name:p.city_name||p.city?.name||"",iata_code:p.iata_code||p.iata_city_code,type:p.type,country:p.iata_country_code,label:[p.name,p.city_name||p.city?.name,p.iata_code||p.iata_city_code,p.iata_country_code].filter(Boolean).join(" · ")})).filter(p=>p.iata_code)});
  }
  if(action!=="search")return json({error:"Unsupported flight action."},400);
  const originCode=clip(b.origin,3).toUpperCase(),destinationCode=clip(b.destination,3).toUpperCase();
  if(!/^[A-Z]{3}$/.test(originCode)||!/^[A-Z]{3}$/.test(destinationCode)||originCode===destinationCode)return json({error:"Choose valid, different origin and destination airport/city suggestions."},400);
  if(!dateOk(b.departureDate)||!dateOk(b.returnDate)||b.returnDate<b.departureDate)return json({error:"Enter valid outbound and return dates."},400);
  const passengers=passengersFrom(b),paxCount=passengers.length;
  const cabins=["economy","premium_economy","business","first"];
  const requests=[];
  for(const cabin of cabins)for(const leg of [{segment:"outbound",from:originCode,to:destinationCode,date:b.departureDate},{segment:"return",from:destinationCode,to:originCode,date:b.returnDate}]){
   requests.push((async()=>{
    const result=await duffel("/air/offer_requests?return_offers=true&supplier_timeout=18000",{...token},{method:"POST",body:JSON.stringify({data:{slices:[{origin:leg.from,destination:leg.to,departure_date:leg.date}],passengers,cabin_class:cabin,max_connections:2}})});
    const offers=result.data?.offers||[];
    return offers.map(o=>mapOffer(o,leg.segment,cabin,paxCount)).filter(Boolean);
   })());
  }
  const settled=await Promise.allSettled(requests),options=[],errors=[];
  for(let i=0;i<settled.length;i++){const item=settled[i];if(item.status==="fulfilled")options.push(...item.value);else errors.push(String(item.reason?.message||item.reason));}
  if(!options.length)return json({error:errors[0]||"No live offers were returned for this route and date. Try another date or cabin."},502);
  const local=clip(b.localCurrency,3).toUpperCase(),home=clip(b.homeCurrency,3).toUpperCase(),rate=Number(b.exchangeRateToHome)||0;
  for(const option of options){
   let totalLocal=null;
   if(option.provider_currency===local)totalLocal=option.provider_total_amount;
   else if(option.provider_currency===home&&rate>0)totalLocal=option.provider_total_amount/rate;
   option.price_estimate=totalLocal===null?0:totalLocal/paxCount;
   option.adult_price_per_person=option.price_estimate;
   option.child_price_per_person=option.price_estimate;
   option.infant_price_per_person=option.price_estimate;
   if(totalLocal===null){option.price_unverified=true;option.fare_notes+=" The provider currency differs from the trip budget currencies, so this offer is not included in the budget.";}
  }
  options.sort((a,b)=>a.provider_total_amount-b.provider_total_amount);
  return json({source:"Duffel live offers",liveMode:options.some(x=>x.provider_live_mode),searchedAt:new Date().toISOString(),origin:originCode,destination:destinationCode,options:options.slice(0,120),partial:errors.length>0,notice:"Live prices and availability can change or expire. This search does not book tickets.",errors:errors.slice(0,2)});
 }catch(error){console.error("Duffel flight search failed:",error);return json({error:error?.message||"Live flight search failed."},502)}
}