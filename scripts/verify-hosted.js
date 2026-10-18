// Deployment acceptance test. Credentials are supplied on hidden stdin, never CLI arguments.
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
if(process.stdin.isTTY) process.stdin.setRawMode(true);
const lines=createInterface({input:process.stdin,terminal:false});
console.log('Ready for hidden test configuration');
const config=await new Promise(resolve=>lines.once('line',line=>resolve(JSON.parse(line))));lines.close();
const base=config.base||'https://nmgjkexfgytjivxudsmo.supabase.co/functions/v1/wingchat';
const cookies={}; const checks=[];
async function request(who,path,method='GET',data,headers={}){
 const r=await fetch(base+path,{method,headers:{Origin:'https://wingfactor-support-chat.netlify.app',...(cookies[who]?{Cookie:cookies[who]}:{}),...(data&&!(data instanceof Uint8Array)?{'Content-Type':'application/json'}:{}),...headers},body:data?data instanceof Uint8Array?data:JSON.stringify(data):undefined,signal:AbortSignal.timeout(30000),redirect:'manual'});
 const c=r.headers.get('set-cookie');if(c)cookies[who]=c.split(';')[0];
 const text=await r.text();let body;try{body=JSON.parse(text);}catch{body=text;}
 return {status:r.status,body,location:r.headers.get('location')};
}
try{
 const login=await request('admin','/login','POST',{username:config.username,password:config.password});assert.equal(login.status,200,JSON.stringify(login.body));checks.push('admin login');
 const me=await request('admin','/me');assert.equal(me.body.user.role,'admin');checks.push('persistent session');
 const uname='qa-agent-'+randomUUID().slice(0,8);
 const created=await request('admin','/users','POST',{name:'QA teammate',username:uname,password:config.password});assert.equal(created.status,201,JSON.stringify(created.body));const agentId=created.body.id;
 assert.equal((await request('agent','/login','POST',{username:uname,password:config.password})).status,200);
 const r=await request('admin','/rooms','POST',{name:'SECRET QA CLIENT',contact:'SECRET QA PHONE',agentIds:[agentId]});assert.equal(r.status,201,JSON.stringify(r.body));const roomId=r.body.roomId;
 assert.equal((await request('client','/client/session','POST',{key:new URLSearchParams(new URL(r.body.link).hash.slice(1)).get('key')})).status,200);
 const list=await request('agent','/rooms');assert.equal(list.status,200);assert.equal(JSON.stringify(list.body).includes('SECRET QA'),false);checks.push('server identity masking');
 assert.equal((await request('agent','/users')).status,403);assert.equal((await request('client','/rooms/'+roomId,'DELETE')).status,403);checks.push('admin-only controls');
 const agentMe=await request('agent','/me');const rt=agentMe.body.realtime;
 const client=createClient(rt.url,rt.key,{auth:{persistSession:false,autoRefreshToken:false}});
 let wake;const awakened=new Promise(resolve=>wake=resolve);
 const channel=client.channel(rt.topic).on('broadcast',{event:'change'},payload=>wake(payload));
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Realtime subscription timeout')),15000);channel.subscribe(status=>{if(status==='SUBSCRIBED'){clearTimeout(timer);resolve();}});});
 const nonce=randomUUID();const sent=await request('client',`/rooms/${roomId}/messages`,'POST',{body:'Please help',nonce});assert.equal(sent.status,201,JSON.stringify(sent.body));
 assert.equal((await request('client',`/rooms/${roomId}/messages`,'POST',{body:'Please help',nonce})).body.id,sent.body.id);checks.push('idempotent live messaging');
 const event=await Promise.race([awakened,new Promise((_,reject)=>setTimeout(()=>reject(Error('Realtime delivery timeout')),15000))]);assert.ok(Object.keys(event.payload).every(key=>key==='id'));checks.push('realtime websocket event');await client.removeChannel(channel);client.realtime.disconnect();
 const file=await request('client',`/rooms/${roomId}/upload`,'POST',new TextEncoder().encode('QA file content'),{'X-Filename':'qa-note.txt','Content-Type':'text/plain'});assert.equal(file.status,201,JSON.stringify(file.body));const attachmentId=file.body.attachmentId;
 assert.equal((await request('client',`/rooms/${roomId}/messages`,'POST',{body:'File attached',attachmentId,nonce:randomUUID()})).status,201);
 const media=await request('agent',`/media/${attachmentId}`);assert.equal(media.status,302);assert.ok(media.location.includes('token='));checks.push('direct private media');
 assert.equal((await request('agent',`/rooms/${roomId}/messages`,'POST',{body:'I can help.',nonce:randomUUID()})).status,201);checks.push('teammate reply');
 await request('client',`/rooms/${roomId}/messages`,'POST',{body:'Second question',nonce:randomUUID()});
 console.log(JSON.stringify({ok:true,checks,roomId,agentId,attachmentId,cookies}));
}catch(error){console.log(JSON.stringify({ok:false,error:error.message,checks}));process.exitCode=1;}
process.exit(process.exitCode||0);
