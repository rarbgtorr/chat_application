import{createInterface}from'node:readline';import assert from'node:assert/strict';import{randomUUID}from'node:crypto';
if(process.stdin.isTTY)process.stdin.setRawMode(true);const reader=createInterface({input:process.stdin,terminal:false});console.log('Ready for hidden test configuration');const c=await new Promise(resolve=>reader.once('line',v=>resolve(JSON.parse(v))));reader.close();
const base='https://nmgjkexfgytjivxudsmo.supabase.co/functions/v1/wingchat';
async function call(who,path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:'https://wingfactor-support-chat.netlify.app',Cookie:c.cookies[who],...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});return{status:r.status,body:await r.json()};}
try{
 const worker=await fetch(base+'/worker',{method:'POST',headers:{'x-worker-key':c.workerKey,'Content-Type':'application/json'},body:'{}'});assert.equal(worker.status,200);
 const media=await call('agent','/media/'+c.attachmentId);assert.equal(media.status,410);
 const history=await call('agent',`/rooms/${c.roomId}/messages`);assert.ok(history.body.messages.some(m=>m.attachment_expired));assert.ok(history.body.messages.some(m=>m.body==='Please help'));
 const reminders=await call('agent','/alerts');assert.ok(reminders.body.some(a=>a.kind==='reminder'));
 const escalations=await call('admin','/alerts');assert.ok(escalations.body.some(a=>a.kind==='escalation'));
 const reply=await call('agent',`/rooms/${c.roomId}/messages`,{body:'Answered',nonce:randomUUID()});assert.equal(reply.status,201);
 const rooms=await call('agent','/rooms');assert.equal(rooms.body.find(r=>r.id===c.roomId).waitingSince,null);
 console.log(JSON.stringify({ok:true,checks:['7-day expiry blocks file access','expired attachment marker','text history retained','5-minute reminder','10-minute admin escalation','reply cancels pending cycle']}));
}catch(e){console.log(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
process.exit(process.exitCode||0);
