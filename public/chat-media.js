import {VoiceCall} from './voice-call.js';
const cameraIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h4l2-3h6l2 3h4v15H3Z"/><circle cx="12" cy="13" r="4"/></svg>';
const switchIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7-4 4 4 4M3 11h13a4 4 0 0 1 4 4v2M17 3l4 4-4 4M21 7H8a4 4 0 0 0-4 4"/></svg>';
const sendIcon='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m22 2-7 20-4-9L2 9 22 2ZM22 2 11 13"/></svg>';

export class Camera {
  constructor({devices,video,onError=()=>{}}){Object.assign(this,{devices,video,onError});this.facing='environment';this.generation=0;}
  stop(){++this.generation;this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;if(this.video)this.video.srcObject=null;}
  async open(){
    this.stop();const generation=this.generation;
    if(!this.devices?.getUserMedia)throw new Error('Live camera is unavailable in this browser.');
    const stream=await this.devices.getUserMedia({audio:false,video:{facingMode:{ideal:this.facing},width:{ideal:1920},height:{ideal:1080}}});
    if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());return;}
    this.stream=stream;this.video.srcObject=stream;await this.video.play();
  }
  async flip(){this.facing=this.facing==='environment'?'user':'environment';await this.open();}
  async capture(document){
    if(!this.video.videoWidth)throw new Error('Wait for the camera preview before taking a photo.');
    const canvas=document.createElement('canvas');const scale=Math.min(1,2000/this.video.videoWidth);
    canvas.width=Math.round(this.video.videoWidth*scale);canvas.height=Math.round(this.video.videoHeight*scale);
    canvas.getContext('2d').drawImage(this.video,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.88));if(!blob)throw new Error('Could not capture this photo. Please try again.');
    this.stop();return new File([blob],`photo-${Date.now()}.jpg`,{type:'image/jpeg'});
  }
}

export function sendCapturedPhoto(preview,file,document){
  const form=document.querySelector('#message-form');
  if(!form?.requestSubmit)throw new Error('This conversation is unavailable. Please try again.');
  if(preview(file,true)!==false)form.requestSubmit();
}

export class IncomingRingtone {
  constructor({ring,timers=globalThis,interval=1400}){Object.assign(this,{ring,timers,interval});this.callId=null;this.timer=null;}
  start(callId){if(this.callId===callId&&this.timer!==null)return;this.stop();this.callId=callId;this.ring();this.timer=this.timers.setInterval(()=>this.ring(),this.interval);}
  stop(){if(this.timer!==null)this.timers.clearInterval(this.timer);this.timer=null;this.callId=null;}
}

export function installMedia({api,post,config,room,preview,modal,dismiss,toast,recording,beep}){
  const host=document.createElement('section');host.id='call-panel';host.className='call-panel hidden';host.setAttribute('aria-live','polite');document.body.append(host);
  const audio=document.createElement('audio');audio.autoplay=true;document.body.append(audio);
  let camera=null,photo=null,photoUrl=null,closed=false,syncing=false,remoteStream=null,localStream=null;
  const ringtone=new IncomingRingtone({ring:beep});
  const attach=(selector,stream,muted=false)=>{const el=host.querySelector(selector);if(!el)return;el.muted=muted;if(el.srcObject!==stream)el.srcObject=stream;if(stream)void el.play().catch(()=>{});};
  const render=c=>{
    host.classList.toggle('hidden',!c);host.classList.toggle('video-call',c?.media==='video');if(!c){host.replaceChildren();return;}
    const incoming=c.incoming&&c.status==='ringing',video=c.media==='video',kind=video?'video':'voice';
    host.innerHTML=`${video?'<div class="call-videos"><video id="call-remote-video" autoplay playsinline></video><video id="call-local-video" autoplay playsinline muted></video></div>':''}<div class="call-summary"><strong></strong><p></p></div><div class="call-actions"></div>`;
    host.querySelector('strong').textContent=incoming?`Incoming ${kind} call`:c.status==='active'?`${video?'Video':'Voice'} call connected`:c.status==='connecting'?`Connecting ${kind} call…`:`Calling with ${kind}…`;
    const name=room(c.roomId)?.code||'Support conversation';host.querySelector('p').textContent=name+(c.connectedAt?' · '+Math.max(0,Math.floor((Date.now()-c.connectedAt)/1000))+'s':'');
    const add=(text,action,style)=>{const b=document.createElement('button');b.textContent=text;b.className=style||'secondary';b.dataset.callAction=action;host.querySelector('.call-actions').append(b);};
    if(incoming){add(video?'Answer with video':'Answer','answer','primary');add('Decline','end','danger');}
    else{
      if(c.status==='active'||c.status==='connecting'){add(c.muted?'Unmute':'Mute','mute');if(video)add(c.cameraOff?'Turn camera on':'Turn camera off','camera');}
      add(c.status==='ringing'?'Cancel':'Hang up','end','danger');
    }
    if(video){attach('#call-remote-video',remoteStream);attach('#call-local-video',localStream,true);if(remoteStream&&host.querySelector('#call-remote-video')?.paused)add('Play call','play');}
    else{audio.srcObject=remoteStream;if(audio.paused&&audio.srcObject)add('Play call audio','play');}
  };
  const voice=new VoiceCall({request:d=>post('/api/calls',d),mediaDevices:navigator.mediaDevices,PeerConnection:window.RTCPeerConnection,config,onChange:c=>{render(c);if(c?.incoming&&c.status==='ringing')ringtone.start(c.id);else ringtone.stop();},
    onRemote:stream=>{remoteStream=stream;if(voice.call?.media==='video')attach('#call-remote-video',stream);else{audio.srcObject=stream;if(stream)void audio.play().catch(()=>render(voice.call));}},
    onLocal:stream=>{localStream=stream;attach('#call-local-video',stream,true);},onError:e=>toast(e.message)});
  const click=async e=>{const a=e.target.closest('[data-call-action]')?.dataset.callAction;if(!a)return;try{
    if(a==='answer'){if(recording())throw new Error('Stop recording your voice note first.');await voice.accept();}
    if(a==='end')await voice.end();if(a==='mute')voice.mute();if(a==='camera')voice.toggleCamera();
    if(a==='play'){if(voice.call?.media==='video')await host.querySelector('#call-remote-video')?.play();else await audio.play();}
  }catch(error){toast(error.message);}};
  host.addEventListener('click',click);
  const closeCamera=()=>{camera?.stop();camera=null;photo=null;if(photoUrl)URL.revokeObjectURL(photoUrl);photoUrl=null;document.querySelector('#modal')?.classList.remove('camera-dialog');};
  async function openCamera(){
    if(voice.call||voice.busy)throw new Error('Finish your call before taking a photo.');
    modal('Take a photo',`<div class="camera-view"><video id="camera-video" autoplay playsinline muted></video><img id="camera-photo" class="hidden" alt="Photo preview"></div><p id="camera-error" role="status"></p><div class="camera-controls"><span class="camera-side"><button class="secondary hidden" type="button" data-camera="retake">Retake</button></span><span class="camera-capture"><button class="camera-shutter" type="button" data-camera="capture" aria-label="Take photo" title="Take photo">${cameraIcon}</button><span>Take photo</span></span><span class="camera-side camera-side-right"><button class="camera-switch" type="button" data-camera="flip" aria-label="Switch camera" title="Switch camera">${switchIcon}</button><button class="camera-send hidden" type="button" data-camera="use" aria-label="Send photo" title="Send photo">${sendIcon}</button></span></div>`);
    document.querySelector('#modal').classList.add('camera-dialog');
    camera=new Camera({devices:navigator.mediaDevices,video:document.querySelector('#camera-video')});
    try{await camera.open();}catch(e){closeCamera();document.querySelector('#modal')?.classList.add('camera-dialog');const error=document.querySelector('#camera-error');if(error)error.textContent=e.name==='NotAllowedError'?'Camera permission was denied. Allow camera access in your browser settings.':e.message;}
  }
  const cameraClick=async e=>{
    const action=e.target.closest('[data-camera]')?.dataset.camera;if(!action)return;
    try{
      if(action==='flip')await camera?.flip();
      if(action==='retake'){closeCamera();await openCamera();}
      if(action==='capture'){
        if(!camera)throw new Error('Camera is unavailable. Allow camera access and try again.');
        photo=await camera.capture(document);photoUrl=URL.createObjectURL(photo);document.querySelector('#camera-photo').src=photoUrl;
        document.querySelector('#camera-photo').classList.remove('hidden');document.querySelector('#camera-video').classList.add('hidden');
        document.querySelector('.camera-capture').classList.add('hidden');document.querySelector('[data-camera="flip"]').classList.add('hidden');
        document.querySelector('[data-camera="retake"]').classList.remove('hidden');document.querySelector('[data-camera="use"]').classList.remove('hidden');
      }
      if(action==='use'&&photo){const file=photo;sendCapturedPhoto(preview,file,document);dismiss();closeCamera();}
    }catch(error){toast(error.message);}
  };
  document.addEventListener('click',cameraClick);
  document.querySelector('#modal').addEventListener('close',closeCamera);
  document.querySelector('#modal').addEventListener('cancel',closeCamera);
  async function sync(){
    if(closed||syncing)return;syncing=true;
    try{
      if(voice.ready)await voice.poll();
      const calls=await api('/api/calls');voice.lastGood=Date.now();if(closed)return;
      if(voice.call&&!voice.ready&&!voice.busy&&!calls.some(c=>c.id===voice.call.id)){voice.clean();}
      if(!voice.call){const c=calls.find(c=>c.incoming&&c.status==='ringing');if(c)voice.incoming(c);}
    }catch(e){if(e.status===401||e.status===403){voice.clean();}else if(voice.call&&voice.ready&&Date.now()-(voice.lastGood||Date.now())>45000)await voice.fail(new Error('Call server unreachable. Please reconnect.'));}
    finally{syncing=false;}
  }
  const timer=setInterval(()=>{if(voice.call||!document.hidden)void sync();},2000);
  const leave=()=>{ringtone.stop();if(voice.call)void post('/api/calls',{action:voice.ready?'end':'decline',callId:voice.call.id}).catch(()=>{});voice.clean();closeCamera();};
  window.addEventListener('pagehide',leave);
  return {sync,closeCamera,camera:openCamera,call:async(id,media='voice')=>{if(recording())throw new Error('Stop recording your voice note first.');await voice.start(id,media);},active:()=>Boolean(voice.call||voice.busy),close(){closed=true;clearInterval(timer);leave();host.remove();audio.remove();document.removeEventListener('click',cameraClick);document.querySelector('#modal').removeEventListener('close',closeCamera);document.querySelector('#modal').removeEventListener('cancel',closeCamera);window.removeEventListener('pagehide',leave);}};
}
