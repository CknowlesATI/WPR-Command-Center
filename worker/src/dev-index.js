import {normalizePlanningItem} from "./planning-contract.js";

// Intentionally separate from production Worker; requires Cloudflare Access identity AND a distinct dev D1 binding.
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json","cache-control":"no-store","x-content-type-options":"nosniff"}});
const unauthorized=()=>reply({ok:false,error:"Authentication required"},401);
function decode(segment){const b64=segment.replace(/-/g,"+").replace(/_/g,"/");const bytes=atob(b64.padEnd(Math.ceil(b64.length/4)*4,"="));return Uint8Array.from(bytes,c=>c.charCodeAt(0));}
function parseJson(segment){return JSON.parse(new TextDecoder().decode(decode(segment)));}
async function verifyAccess(request,env){
 const team=String(env.ACCESS_TEAM_DOMAIN||"");
 const aud=String(env.ACCESS_AUD||"");
 const token=request.headers.get("Cf-Access-Jwt-Assertion")||"";
 if(!team||!aud||!/^[-a-z0-9]+\.cloudflareaccess\.com$/.test(team)||!token)return null;
 const parts=token.split(".");if(parts.length!==3)return null;
 let header,payload;try{header=parseJson(parts[0]);payload=parseJson(parts[1]);}catch{return null;}
 if(header.alg!=="RS256"||!header.kid||typeof payload.exp!=="number"||payload.exp<=Date.now()/1000)return null;
 if(payload.nbf&&payload.nbf>Date.now()/1000)return null;
 if(payload.iss!=="https://"+team||!(Array.isArray(payload.aud)?payload.aud.includes(aud):payload.aud===aud))return null;
 const keysResponse=await fetch("https://"+team+"/cdn-cgi/access/certs");
 if(!keysResponse.ok)return null;
 const keys=await keysResponse.json();
 const jwk=(keys.keys||[]).find(k=>k.kid===header.kid&&k.kty==="RSA");
 if(!jwk)return null;
 const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
 const signature=decode(parts[2]);
 const valid=await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,signature,new TextEncoder().encode(parts[0]+"."+parts[1]));
 if(!valid)return null;
 return String(payload.email||payload.sub||"authenticated");
}
export default {async fetch(request,env){
 try{
  // Explicit guard against accidentally binding the production database in dev.
  if(!env.DB||env.DB_NAME!=="wpr-command-center-planning-dev")return reply({ok:false,error:"Development database is not configured"},503);
  const actor=await verifyAccess(request,env);if(!actor)return unauthorized();
  const url=new URL(request.url);
  if(request.method==="GET"&&url.pathname==="/health")return reply({ok:true,environment:"planning-development"});
  if(request.method==="GET"&&url.pathname==="/planning"){
   const rows=await env.DB.prepare("SELECT * FROM planning_items ORDER BY follow_up_date,due_date LIMIT 500").all();
   return reply({ok:true,items:rows.results||[]});
  }
  if(request.method==="POST"&&url.pathname==="/planning"){
   const raw=await request.json();const item=normalizePlanningItem(raw.item);
   const project=await env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(item.projectId).first();
   if(!project)return reply({ok:false,error:"Unknown development project"},400);
   const id=crypto.randomUUID(),at=new Date().toISOString();
   await env.DB.prepare("INSERT INTO planning_items(id,project_id,unit_label,title,description,item_type,status,priority,owner,start_date,due_date,follow_up_date,source_task_id,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
   .bind(id,item.projectId,item.unitLabel,item.title,item.description,item.itemType,item.status,item.priority,item.owner,item.startDate,item.dueDate,item.followUpDate,item.sourceTaskId||null,at,at,actor).run();
   return reply({ok:true,id},201);
  }
  return reply({ok:false,error:"Not found"},404);
 }catch(error){return reply({ok:false,error:"Request failed"},500);}
}};
