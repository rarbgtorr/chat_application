import { randomBytes, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
const id=()=>randomBytes(18).toString('base64url');
const secret=()=>randomBytes(32).toString('base64url');
const hash=v=>createHash('sha256').update(v).digest('hex');
async function passwordHash(value){
 const salt=randomBytes(16).toString('hex');const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(value),'PBKDF2',false,['deriveBits']);
 const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:600000,hash:'SHA-256'},key,256);
 return 'pbkdf2:600000:'+salt+':'+Buffer.from(bits).toString('hex');
}
async function matches(value,stored){
 try{const [kind,iterations,salt,wanted]=stored.split(':');if(kind!=='pbkdf2'||+iterations!==600000)return false;
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(value),'PBKDF2',false,['deriveBits']);
 const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:new TextEncoder().encode(salt),iterations:+iterations,hash:'SHA-256'},key,256);
 const actual=Buffer.from(bits).toString('hex');if(actual.length!==wanted.length)return false;let diff=0;for(let n=0;n<actual.length;n++)diff|=actual.charCodeAt(n)^wanted.charCodeAt(n);return diff===0;
 }catch{return false;}
}
const str=(v,max=1000)=>typeof v==='string'?v.trim().slice(0,max):'';
const validPass=v=>typeof v==='string'&&v.length>=14&&v.length<=200;
const types={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',mp3:'audio/mpeg',m4a:'audio/mp4',ogg:'audio/ogg',wav:'audio/wav',pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',txt:'text/plain',csv:'text/csv'};
const check=(ok,status,message)=>{if(!ok){const e=new Error(message);e.status=status;throw e;}};
export function createHandler({db,webpush,supabaseUrl,waitUntil=fn=>fn.catch(()=>{}),clock=Date.now}){
 const table=name=>db.from('wc_'+name);
 async function result(query){const {data,error}=await query;if(error){const m=/^(\d{3})\|(.+)$/.exec(error.message);if(m)check(false,+m[1],m[2]);throw error;}return data;}
 const all=(name,query)=>result(query||table(name).select('*'));
 const one=async(name,column,value)=>{const rows=await result(table(name).select('*').eq(column,value).limit(1));return rows?.[0]||null;};
 const put=(name,row)=>result(table(name).insert(row));
 const remove=(name,column,value)=>result(table(name).delete().eq(column,value));
 const patch=(name,column,value,data)=>result(table(name).update(data).eq(column,value));
 const rpc=(name,args={})=>result(db.rpc('wc_'+name,args));
 async function actor(tokenHash){
  const s=await one('sessions','token_hash',tokenHash);if(!s)return null;
  if(s.user_id){const u=await one('users','id',s.user_id);return u&&!u.disabled?{...u,sessionHash:tokenHash,liveKey:s.live_key}:null;}
  return (await one('rooms','id',s.room_id))?{id:s.room_id,roomId:s.room_id,role:'client',sessionHash:tokenHash,liveKey:s.live_key,name:'Client'}:null;
 }
 const admin=a=>check(a?.role==='admin',403,'Administrator access required.');
 async function access(a,roomId){check(await rpc('allowed',{p_token:a.sessionHash,p_room:roomId}),404,'Conversation not found.');const r=await one('rooms','id',roomId);check(r,404,'Conversation not found.');return r;}
 async function limit(key,max,window=60000){check(await rpc('rate',{p_key:key,p_max:max,p_window:window}),429,'Too many attempts. Please try later.');}
 const signal=roomId=>rpc('signal',{p_room:roomId||null});
 async function json(req){check((+req.headers.get('content-length')||0)<65536,413,'Request too large.');const raw=await req.text();check(raw.length<=65536,413,'Request too large.');try{const v=JSON.parse(raw);check(v&&typeof v==='object'&&!Array.isArray(v),400,'Invalid JSON.');return v;}catch(e){check(false,e.status||400,e.message||'Invalid JSON.');}}
 async function agents(roomId){const assignments=await result(table('assignments').select('user_id').eq('room_id',roomId));if(!assignments.length)return[];return result(table('users').select('id,name').in('id',assignments.map(x=>x.user_id)).eq('disabled',false));}
 async function subscriptionsFor(userId,roomId){const sessions=await result(table('sessions').select('token_hash').eq(userId?'user_id':'room_id',userId||roomId));if(!sessions.length)return[];return result(table('subscriptions').select('*').in('session_hash',sessions.map(s=>s.token_hash)));}
 async function notify(userId,roomId,kind,title,message,client=false,cycle=null){await rpc('notify',{p_user:client?null:userId,p_client:client?roomId:null,p_room:roomId,p_kind:kind,p_cycle:cycle,p_title:title,p_body:message});}
 async function cleanup(){
  const items=await result(table('deletions').select('id').limit(100));
  if(items.length){const {error}=await db.storage.from('wingchat-media').remove(items.map(x=>x.id));if(!error)await result(table('deletions').delete().in('id',items.map(x=>x.id)));}
 }
 async function worker(config){
  await rpc('schedule');await cleanup();
  const jobs=await rpc('claim_jobs');
  await Promise.all((jobs||[]).map(async job=>{
   // Re-read after leasing: a reply or revocation may have cancelled the job meanwhile.
   if(!await one('push_jobs','id',job.id))return;
   const sub=await one('subscriptions','endpoint',job.endpoint);const a=sub&&await actor(sub.session_hash);
   if(!a||(job.room_id&&!await rpc('allowed',{p_token:a.sessionHash,p_room:job.room_id}))){await remove('push_jobs','id',job.id);return;}
   try{await webpush.sendNotification(sub.subscription,JSON.stringify(job.payload),{vapidDetails:{subject:config.contact,publicKey:config.vapid.publicKey,privateKey:config.vapid.privateKey},urgency:'high',TTL:300,timeout:10000});await remove('push_jobs','id',job.id);}
   catch(e){if([404,410].includes(e.statusCode))await remove('subscriptions','endpoint',job.endpoint);else await patch('push_jobs','id',job.id,{attempts:job.attempts+1,leased_until:0,next_at:clock()+Math.min(300000,1000*2**Math.min(8,job.attempts+1))});}
  }));
 }
 async function summary(a,room){
  const [last,marker,assigned,cycle]=await Promise.all([
   result(table('messages').select('body,created_at,sender_role,attachment_id').eq('room_id',room.id).order('seq',{ascending:false}).limit(1)),
   result(table('reads').select('seq').eq('room_id',room.id).eq('subject',a.role==='client'?'client:'+room.id:a.id)),agents(room.id),one('cycles','room_id',room.id)]);
  let unread=table('messages').select('seq',{count:'exact',head:true}).eq('room_id',room.id).gt('seq',marker[0]?.seq||0);
  unread=a.role==='client'?unread.neq('sender_role','client'):unread.eq('sender_role','client');
  const count=await unread;
  const r={...room,last:last[0]?{...last[0],body:last[0].body||'Attachment'}:null,unread:count.count||0,agents:assigned,waitingSince:cycle?.first_at||null};
  if(a.role==='admin')r.private=await one('contacts','room_id',room.id);return r;
 }
 return async function handler(req){
  const headers=new Headers({'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
  try{
   const setting=await one('settings','key','config');check(setting,503,'Support is being configured.');const config=setting.value;
   let path=new URL(req.url).pathname.replace(/^.*\/wingchat/,'');if(path.startsWith('/api'))path=path.slice(4);const method=req.method;
   if(path==='/worker'){
    check(method==='POST'&&req.headers.get('x-worker-key')===config.workerKey,403,'Forbidden.');await worker(config);return reply({ok:true});
   }
   if(!['GET','HEAD'].includes(method))check(req.headers.get('origin')===config.origin,403,'Request origin not allowed.');
   const cookieToken=/(?:^|;\s*)wf_session=([\w-]+)/.exec(req.headers.get('cookie')||'')?.[1];
   const sessionCookie=token=>headers.append('Set-Cookie',`wf_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`);
   async function session(userId,roomId){const token=secret();await put('sessions',{token_hash:hash(token),user_id:userId,room_id:roomId,live_key:'wc-'+secret(),created_at:clock()});sessionCookie(token);}
   if(path==='/healthz')return reply({ok:true});
   if(path==='/setup'&&method==='POST'){
    const d=await json(req);check(validPass(d.password),400,'Use a password with 14–200 characters.');const username=str(d.username,100).toLowerCase();check(/^[a-z0-9_.@-]{3,100}$/.test(username)&&typeof d.key==='string',400,'Invalid account details.');
    await limit('setup',10,600000);const userId=id();check(await rpc('setup',{p_key:hash(d.key),p_id:userId,p_username:username,p_password:await passwordHash(d.password)}),403,'Setup link expired or already used.');await session(userId,null);return reply({ok:true});
   }
   if(path==='/login'&&method==='POST'){
    const d=await json(req);const username=str(d.username,100).toLowerCase();await limit('login:'+username,10,600000);
    check(typeof d.password==='string'&&d.password.length<=200,401,'Incorrect username or password.');const u=await one('users','username',username);
    const good=await matches(d.password,u?.password||await passwordHash('dummy-password-long-enough'));
    check(u&&!u.disabled&&good,401,'Incorrect username or password.');await session(u.id,null);return reply({ok:true});
   }
   if(path==='/client/session'&&method==='POST'){
    const d=await json(req);check(typeof d.key==='string'&&d.key.length<=100,401,'Invalid support link.');await limit('client:'+hash(d.key),30,600000);const k=await one('keys','key_hash',hash(d.key));check(k,401,'This link is invalid or revoked.');await session(null,k.room_id);return reply({roomId:k.room_id});
   }
   const a=cookieToken&&await actor(hash(cookieToken));check(a,401,'Please sign in or open your private support link.');sessionCookie(cookieToken);
   if(path==='/me')return reply({user:{id:a.id,role:a.role,name:a.name,roomId:a.roomId},push:{enabled:true,publicKey:config.vapid.publicKey,devices:(await result(table('subscriptions').select('endpoint').eq('session_hash',a.sessionHash))).length},realtime:{url:supabaseUrl,key:config.publishableKey,topic:a.liveKey}});
   if(path==='/logout'&&method==='POST'){await remove('sessions','token_hash',a.sessionHash);headers.set('Set-Cookie','wf_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');return reply({ok:true});}
   if(path==='/password'&&method==='POST'){
    check(a.role!=='client',403,'Staff only.');await limit('password:'+a.id,8,600000);const d=await json(req);check(typeof d.current==='string'&&d.current.length<=200&&await matches(d.current,a.password),403,'Current password is incorrect.');check(validPass(d.password),400,'Use 14–200 characters.');await patch('users','id',a.id,{password:await passwordHash(d.password)});await remove('sessions','user_id',a.id);await session(a.id,null);return reply({ok:true});
   }
   if(path==='/users'){
    admin(a);if(method==='GET')return reply(await result(table('users').select('id,username,name,role,disabled').order('name')));
    if(method==='POST'){const d=await json(req);check(validPass(d.password)&&/^[a-z0-9_.@-]{3,100}$/.test(str(d.username,100).toLowerCase())&&str(d.name,80),400,'Use a valid username, name, and 14+ character password.');const userId=id();check(!await one('users','username',d.username.toLowerCase()),409,'Username already exists.');await put('users',{id:userId,username:d.username.toLowerCase(),name:str(d.name,80),role:'agent',password:await passwordHash(d.password)});return reply({id:userId},201);}
   }
   const userMatch=/^\/users\/([\w-]+)$/.exec(path);
   if(userMatch&&method==='PATCH'){
    admin(a);const u=await one('users','id',userMatch[1]);check(u&&u.role==='agent',403,'Teammate account required.');const d=await json(req),changes={};
    if(d.password!==undefined){check(validPass(d.password),400,'Use 14–200 characters.');changes.password=await passwordHash(d.password);}if(typeof d.disabled==='boolean')changes.disabled=d.disabled;
    await patch('users','id',u.id,changes);await remove('sessions','user_id',u.id);await signal(null);return reply({ok:true});
   }
   if(path==='/rooms'){
    if(method==='GET'){
     let q=table('rooms').select('*').order('created_at',{ascending:false});
     if(a.role==='client')q=q.eq('id',a.roomId);
     else if(a.role!=='admin'){const assigned=await result(table('assignments').select('room_id').eq('user_id',a.id));if(!assigned.length)return reply([]);q=q.in('id',assigned.map(x=>x.room_id));}
     return reply(await Promise.all((await result(q)).map(r=>summary(a,r))));
    }
    if(method==='POST'){
     admin(a);const d=await json(req),roomId=id(),key=secret(),code='Client #'+secret().slice(0,6).toUpperCase();const chosen=d.agentIds||[];check(Array.isArray(chosen)&&chosen.length<=50,400,'Invalid teammates.');
     for(const uid of chosen){const u=await one('users','id',uid);check(u&&u.role==='agent'&&!u.disabled,400,'Choose active teammates.');}
     await put('rooms',{id:roomId,code,created_at:clock()});
     await put('contacts',{room_id:roomId,name:str(d.name,100),contact:str(d.contact,200),notes:str(d.notes,2000)});await put('keys',{room_id:roomId,key_hash:hash(key)});
     if(chosen.length)await put('assignments',[...new Set(chosen)].map(uid=>({room_id:roomId,user_id:uid})));
     await signal(roomId);return reply({roomId,code,link:`${config.origin}/c/${roomId}#key=${key}`},201);
    }
   }
   const rm=/^\/rooms\/([\w-]+)(?:\/(messages|read|upload|link|revoke))?$/.exec(path);
   if(rm){const roomId=rm[1],action=rm[2];const room=await access(a,roomId);
    if(!action&&method==='DELETE'){admin(a);await rpc('room_delete',{p_token:a.sessionHash,p_room:roomId});await cleanup();return reply({ok:true});}
    if(!action&&method==='PATCH'){
     admin(a);const d=await json(req);
     if(d.status!==undefined){check(['open','closed'].includes(d.status),400,'Invalid status.');await patch('rooms','id',roomId,{status:d.status});if(d.status==='closed'){await remove('cycles','room_id',roomId);await result(table('push_jobs').delete().eq('room_id',roomId).in('kind',['reminder','escalation']));}}
     if(d.private)await patch('contacts','room_id',roomId,{name:str(d.private.name,100),contact:str(d.private.contact,200),notes:str(d.private.notes,2000)});
     if(d.agentIds){check(Array.isArray(d.agentIds)&&d.agentIds.length<=50,400,'Invalid teammates.');for(const uid of d.agentIds){const u=await one('users','id',uid);check(u&&u.role==='agent'&&!u.disabled,400,'Choose active teammates.');}const old=await agents(roomId);await remove('assignments','room_id',roomId);if(d.agentIds.length)await put('assignments',[...new Set(d.agentIds)].map(uid=>({room_id:roomId,user_id:uid})));for(const uid of d.agentIds.filter(uid=>!old.some(u=>u.id===uid)))await notify(uid,roomId,'assigned','Assigned · '+room.code,'A support conversation has been assigned to you.');}
     await signal(null);waitUntil(worker(config));return reply({ok:true});
    }
    if(['link','revoke'].includes(action)&&method==='POST'){
     admin(a);const key=secret();await remove('keys','room_id',roomId);await remove('sessions','room_id',roomId);if(action==='link')await put('keys',{key_hash:hash(key),room_id:roomId});await signal(null);return reply(action==='link'?{link:`${config.origin}/c/${roomId}#key=${key}`}:{ok:true});
    }
    if(action==='messages'&&method==='GET'){
     const before=Number(new URL(req.url).searchParams.get('before'))||Number.MAX_SAFE_INTEGER;
     const rows=await result(table('messages').select('*').eq('room_id',roomId).lt('seq',before).order('seq',{ascending:false}).limit(100));
     const fileIds=rows.map(m=>m.attachment_id).filter(Boolean);const files=fileIds.length?await result(table('attachments').select('id,filename,mime,size,expired,expires_at').in('id',fileIds)):[];
     return reply({messages:rows.reverse().map(m=>{const f=files.find(f=>f.id===m.attachment_id);return {...m,...(f?{filename:f.filename,mime:f.mime,size:f.size,attachment_expired:f.expired||f.expires_at<=clock()}:{}),own:m.sender_id===(a.role==='client'?roomId:a.id),sender:m.sender_role==='client'?room.code:'Wingfactor Support'};}),hasMore:rows.length===100});
    }
    if(action==='messages'&&method==='POST'){
     await limit('message:'+a.sessionHash,120);const d=await json(req);check(typeof d.nonce==='string'&&/^[\w-]{10,100}$/.test(d.nonce),400,'Missing message identifier.');const value=str(d.body,10000);check(value||d.attachmentId,400,'Write a message or attach a file.');
     const message=await rpc('message',{p_token:a.sessionHash,p_room:roomId,p_id:id(),p_body:value,p_file:d.attachmentId||null,p_nonce:d.nonce});waitUntil(worker(config));return reply(message,201);
    }
    if(action==='read'&&method==='POST'){
     const d=await json(req);const latest=await result(table('messages').select('seq').eq('room_id',roomId).order('seq',{ascending:false}).limit(1));const seq=Math.max(0,Math.min(latest[0]?.seq||0,Number(d.seq)||0));
     const subject=a.role==='client'?'client:'+roomId:a.id;const old=await result(table('reads').select('seq').eq('room_id',roomId).eq('subject',subject));await result(table('reads').upsert({room_id:roomId,subject,seq:Math.max(seq,old[0]?.seq||0)}));
     if(a.role!=='client')await result(table('alerts').update({seen:true}).eq('room_id',roomId).eq('user_id',a.id).in('kind',['message','assigned']));return reply({ok:true});
    }
    if(action==='upload'&&method==='POST'){
     check(room.status==='open',409,'Conversation is closed.');await limit('upload:'+a.sessionHash,20);const filename=str(decodeURIComponent(req.headers.get('x-filename')||''),200).replace(/[\x00-\x1f\\/]/g,'_');const ext=filename.split('.').at(-1).toLowerCase();let mime=types[ext];if(ext==='webm'&&req.headers.get('content-type')?.startsWith('audio/webm'))mime='audio/webm';check(mime,415,'Unsupported file type.');check((+req.headers.get('content-length')||0)<=26214400,413,'Maximum attachment size is 25 MB.');
     const bytes=await req.arrayBuffer();check(bytes.byteLength>0&&bytes.byteLength<=26214400,413,'Maximum attachment size is 25 MB.');await access(await actor(a.sessionHash),roomId);const attachmentId=id();
     const row={id:attachmentId,room_id:roomId,session_hash:a.sessionHash,filename,mime,size:bytes.byteLength,created_at:clock(),expires_at:clock()+7*86400000};
     await rpc('reserve_upload',{p_row:row});
     const {error}=await db.storage.from('wingchat-media').upload(attachmentId,bytes,{contentType:mime,cacheControl:'0',upsert:false});if(error){await remove('attachments','id',attachmentId);throw error;}
     return reply({attachmentId},201);
    }
   }
   const media=/^\/media\/([\w-]+)$/.exec(path);
   if(media&&method==='GET'){
    const f=await one('attachments','id',media[1]);check(f,404,'Attachment not found.');await access(a,f.room_id);check(!f.expired&&f.expires_at>clock(),410,'Attachment expired after 7 days.');
    const inline=/^(image\/|video\/|audio\/)/.test(f.mime)&&new URL(req.url).searchParams.get('download')!=='1';
    const {data,error}=await db.storage.from('wingchat-media').createSignedUrl(f.id,Math.max(1,Math.min(60,Math.floor((f.expires_at-clock())/1000))),inline?{}:{download:f.filename});if(error)throw error;
    headers.set('Location',data.signedUrl);return new Response(null,{status:302,headers});
   }
   if(path==='/alerts'&&method==='GET'){check(a.role!=='client',403,'Staff only.');const alerts=await result(table('alerts').select('*,wc_rooms(code)').eq('user_id',a.id).eq('seen',false).order('created_at',{ascending:false}).limit(100));const visible=[];for(const x of alerts)if(await rpc('allowed',{p_token:a.sessionHash,p_room:x.room_id}))visible.push({...x,code:x.wc_rooms.code,wc_rooms:undefined});return reply(visible);}
   if(path==='/alerts/read'&&method==='POST'){check(a.role!=='client',403,'Staff only.');await patch('alerts','user_id',a.id,{seen:true});return reply({ok:true});}
   if(path==='/push'&&method==='POST'){
    const d=await json(req),s=d.subscription;let u;try{u=new URL(s?.endpoint);}catch{}check(u&&u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&(u.hostname==='fcm.googleapis.com'||u.hostname==='updates.push.services.mozilla.com'||u.hostname.endsWith('.push.apple.com'))&&s.endpoint.length<=2048&&/^[\w-]{20,30}$/.test(s.keys?.auth)&&/^[\w-]{80,100}$/.test(s.keys?.p256dh),400,'Invalid browser push subscription.');
    const old=await one('subscriptions','endpoint',s.endpoint);if(old&&old.session_hash!==a.sessionHash)await remove('subscriptions','endpoint',s.endpoint);await result(table('subscriptions').upsert({endpoint:s.endpoint,subscription:s,session_hash:a.sessionHash,created_at:clock()}));return reply({ok:true});
   }
   if(path==='/push/test'&&method==='POST'){
    await limit('test:'+a.sessionHash,5);const subs=await result(table('subscriptions').select('*').eq('session_hash',a.sessionHash));check(subs.length,400,'Enable notifications on this device first.');
    await put('push_jobs',subs.map(s=>({endpoint:s.endpoint,kind:'test',payload:{title:'Notifications are working',body:'This device can receive support chat alerts.',url:'/',tag:'test'},next_at:clock(),expires_at:clock()+60000})));waitUntil(worker(config));return reply({ok:true,message:'Test queued. Confirm the notification appears on this device.'});
   }
   check(false,404,'Not found.');
  }catch(e){if(!e.status)console.error('Chat API request failed',e.code||e.name);return reply({error:e.status?e.message:'Something went wrong. Please try again.'},e.status||500);}
 };
}
