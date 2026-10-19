import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceCall} from '../public/voice-call.js';
import {Camera,IncomingRingtone,sendCapturedPhoto} from '../public/chat-media.js';
function fixture(options={}){
 const requests=[],constraints=[],added=[];
 const audioTrack={kind:'audio',enabled:true,stopped:false,stop(){this.stopped=true;}},videoTrack={kind:'video',enabled:true,stopped:false,stop(){this.stopped=true;}};
 const tracks=options.videoStream?[audioTrack,videoTrack]:[audioTrack];
 const stream={getTracks:()=>tracks,getAudioTracks:()=>[audioTrack],getVideoTracks:()=>options.videoStream?[videoTrack]:[]};
 class Peer{constructor(){this.connectionState='new';this.ice=[];}addTrack(track){added.push(track);}async createOffer(){return {type:'offer',sdp:'offer-sdp'};}async createAnswer(){return {type:'answer',sdp:'answer-sdp'};}async setLocalDescription(d){this.localDescription=d;this.onicecandidate?.({candidate:{toJSON:()=>({candidate:'local-ice'})}});}async setRemoteDescription(d){this.remoteDescription=d;}async addIceCandidate(i){assert.ok(this.remoteDescription);this.ice.push(i);}close(){this.closed=true;}}
 let latest;
 const voice=new VoiceCall({request:async r=>{requests.push(r);if(options.request)return options.request(r);latest={id:r.callId,roomId:r.roomId,media:voice.call?.media||r.payload.media||r.media||'voice',status:r.action==='accept'?'connecting':r.action==='end'?'ended':'ringing',signals:r.action==='accept'?[{seq:1,kind:'offer',data:{type:'offer',sdp:'remote-offer'}}]:[]};return latest;},mediaDevices:{getUserMedia:options.permission|| (async value=>{constraints.push(value);return stream;})},PeerConnection:Peer,config:{iceServers:[]}});
 return {voice,requests,tracks,audioTrack,videoTrack,stream,constraints,added};
}
test('caller sends offer, trickles ICE and stops microphone on hangup',async()=>{
 const f=fixture();await f.voice.start('room');await f.voice.sending;
 assert.equal(f.requests[0].action,'start');assert.equal(f.requests[0].payload.type,'offer');assert.equal(f.requests[1].payload.kind,'ice');
 assert.equal(f.requests[0].payload.media,'voice');assert.equal(f.constraints[0].video,false);
 const pc=f.voice.pc;f.voice.mute();assert.equal(f.audioTrack.enabled,false);f.voice.mute();assert.equal(f.audioTrack.enabled,true);
 await f.voice.end();assert.ok(pc.closed);assert.ok(f.tracks[0].stopped);assert.equal(f.voice.call,null);
});
test('answerer receives offer only after accepting and sends audio answer',async()=>{
 const f=fixture();f.voice.incoming({id:'incoming-call',roomId:'room',incoming:true,status:'ringing'});assert.equal(f.voice.stream,null);
 await f.voice.accept();await f.voice.sending;
 assert.equal(f.requests[0].action,'accept');assert.equal(f.voice.pc.remoteDescription.type,'offer');
 assert.equal(f.requests.find(r=>r.payload.kind==='answer').payload.data.type,'answer');await f.voice.end();
});
test('video call requests camera, signals its media type, and can pause local video',async()=>{
 const f=fixture({videoStream:true});await f.voice.start('room','video');await f.voice.sending;
 assert.equal(f.requests[0].payload.media,'video');assert.equal(f.constraints[0].video.facingMode,'user');assert.deepEqual(f.added,[f.audioTrack,f.videoTrack]);
 f.voice.toggleCamera();assert.equal(f.videoTrack.enabled,false);f.voice.toggleCamera();assert.equal(f.videoTrack.enabled,true);
 await f.voice.end();assert.ok(f.audioTrack.stopped);assert.ok(f.videoTrack.stopped);
});
test('incoming video call asks for camera only after the teammate answers',async()=>{
 const f=fixture({videoStream:true});f.voice.incoming({id:'incoming-video',roomId:'room',incoming:true,status:'ringing',media:'video'});
 assert.equal(f.constraints.length,0);await f.voice.accept();assert.equal(f.constraints[0].video.facingMode,'user');await f.voice.end();
});
test('remote ICE waits for remote description and is applied in sequence',async()=>{
 const f=fixture();await f.voice.start('room');const call=f.voice.call;
 await f.voice.consume({...call,signals:[{seq:1,kind:'ice',data:{candidate:'remote-ice'}}]});assert.equal(f.voice.pc.ice.length,0);
 await f.voice.consume({...call,signals:[{seq:2,kind:'answer',data:{type:'answer',sdp:'answer'}}]});assert.equal(f.voice.pc.ice[0].candidate,'remote-ice');
 await f.voice.consume({...call,signals:[{seq:1,kind:'ice',data:{candidate:'duplicate'}}]});assert.equal(f.voice.pc.ice.length,1);await f.voice.end();
});
test('denied microphone permission creates no call or microphone leak',async()=>{
 const f=fixture({permission:async()=>{throw new Error('Microphone denied');}});await assert.rejects(f.voice.start('room'),/denied/);assert.equal(f.requests.length,0);assert.equal(f.voice.pc,null);assert.equal(f.voice.busy,false);
});
test('another device answering releases the local microphone',async()=>{
 const f=fixture({request:async()=>{throw new Error('answered elsewhere');}});f.voice.incoming({id:'incoming-call',roomId:'room',incoming:true,status:'ringing'});
 await assert.rejects(f.voice.accept(),/elsewhere/);assert.ok(f.tracks[0].stopped);assert.equal(f.voice.call,null);
});
test('a temporary polling error leaves the active call available for retry',async()=>{
 const f=fixture({request:async r=>{if(r.action==='poll')throw new Error('offline');return {id:r.callId,roomId:r.roomId,status:'ringing',signals:[]};}});await f.voice.start('room');
 await assert.rejects(f.voice.poll(),/offline/);assert.ok(f.voice.call);assert.ok(f.voice.stream);await f.voice.end();
});
test('late microphone permission after cleanup immediately stops tracks',async()=>{
 let resolve;const f=fixture({permission:()=>new Promise(r=>{resolve=r;})});const pending=f.voice.start('room');f.voice.clean();resolve(f.stream);
 await assert.rejects(pending,/cancelled/);assert.ok(f.tracks[0].stopped);assert.equal(f.requests.length,0);
});
test('camera cancellation stops late permission result and never opens microphone',async()=>{
 let resolve,requested;const track={stopped:false,stop(){this.stopped=true;}};const video={srcObject:null,play:async()=>{}};
 const c=new Camera({devices:{getUserMedia:constraints=>{requested=constraints;return new Promise(r=>{resolve=r;});}},video});
 const pending=c.open();c.stop();resolve({getTracks:()=>[track]});await pending;assert.equal(requested.audio,false);assert.ok(track.stopped);assert.equal(video.srcObject,null);
});
test('camera capture creates a JPEG, stops the stream, and switches facing mode',async()=>{
 const track={stop(){this.stopped=true;}};const facing=[];const video={srcObject:null,videoWidth:3000,videoHeight:1500,play:async()=>{}};
 const c=new Camera({devices:{getUserMedia:async q=>{facing.push(q.video.facingMode.ideal);return {getTracks:()=>[track]};}},video});await c.open();await c.flip();assert.deepEqual(facing,['environment','user']);
 const canvas={getContext:()=>({drawImage(){}}),toBlob:cb=>cb(new Blob(['photo'],{type:'image/jpeg'}))};const file=await c.capture({createElement:()=>canvas});assert.equal(canvas.width,2000);assert.equal(canvas.height,1000);assert.equal(file.type,'image/jpeg');assert.match(file.name,/\.jpg$/);assert.ok(track.stopped);assert.equal(video.srcObject,null);
});
test('camera send arrow attaches the captured photo and submits it immediately',()=>{
 const file={name:'captured.jpg'},calls=[];const form={requestSubmit(){calls.push('submit');}};
 sendCapturedPhoto((value,immediate)=>calls.push(value,immediate),file,{querySelector:selector=>selector==='#message-form'?form:null});
 assert.deepEqual(calls,[file,true,'submit']);
});
test('incoming ringtone repeats for one call and stops when the call changes state',()=>{
 const rings=[],intervals=new Map();let next=1;
 const timers={setInterval(fn,ms){const id=next++;intervals.set(id,{fn,ms});return id;},clearInterval(id){intervals.delete(id);}};
 const ringtone=new IncomingRingtone({ring:()=>rings.push('ring'),timers,interval:1400});ringtone.start('call-one');
 assert.equal(rings.length,1);assert.equal(intervals.size,1);assert.equal([...intervals.values()][0].ms,1400);
 ringtone.start('call-one');assert.equal(rings.length,1);assert.equal(intervals.size,1);intervals.values().next().value.fn();assert.equal(rings.length,2);
 ringtone.stop();assert.equal(intervals.size,0);assert.equal(ringtone.callId,null);
});
