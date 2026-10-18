import {VoiceCall} from './voice-call.js';
export class Camera {
  constructor({devices,video,onError=()=>{}}){Object.assign(this,{devices,video,onError});this.facing='environment';this.generation=0;}
  stop(){++this.generation;this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;if(this.video)this.video.srcObject=null;}
  async open(){
    this.stop();const generation=this.generation;
    if(!this.devices?.getUserMedia)throw new Error('Live camera is unavailable. Use “Device camera or photo” below.');
    const stream=await this.devices.getUserMedia({audio:false,video:{facingMode:{ideal:this.facing},width:{ideal:1600}}});
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
export function installMedia({api,post,config,room,preview,modal,dismiss,toast,recording,beep}){
  const host=document.createElement('section');host.id='call-panel';host.className='call-panel hidden';host.setAttribute('aria-live','polite');document.body.append(host);
  const audio=document.createElement('audio');audio.autoplay=true;document.body.append(audio);
  let camera=null,photo=null,photoUrl=null,closed=false,syncing=false,known=null;
  const label=c=>c.incoming?'Wingfactor Support':room(c.roomId)?.code||'Support conversation';
  const render=c=>{
    host.classList.toggle('hidden',!c);if(!c){host.replaceChildren();return;}
    const incoming=c.incoming&&c.status==='ringing';
    host.innerHTML='<div><strong></strong><p></p></div><div class="call-actions"></div>';
    host.querySelector('strong').textContent=incoming?'Incoming voice call':c.status==='active'?'Voice call connected':c.status==='connecting'?'Connecting voice call…':'Calling…';
    const name=room(c.roomId)?.code||label(c);host.querySelector('p').textContent=(name==='Wingfactor Support'?name:room(c.roomId)?.code||'Support conversation')+(c.connectedAt?' · '+Math.max(0,Math.floor((Date.now()-c.connectedAt)/1000))+'s':'');
    const add=(text,action,style)=>{const b=document.createElement('button');b.textContent=text;b.className=style||'secondary';b.dataset.callAction=action;host.querySelector('.call-actions').append(b);};
    if(incoming){add('Answer','answer','primary');add('Decline','end','danger');}
    else{if(c.status==='active'||c.status==='connecting')add(c.muted?'Unmute':'Mute','mute');add(c.status==='ringing'?'Cancel':'Hang up','end','danger');}
    if(audio.paused&&audio.srcObject)add('Play call audio','play');
  };
  const voice=new VoiceCall({request:d=>post('/api/calls',d),mediaDevices:navigator.mediaDevices,PeerConnection:window.RTCPeerConnection,config,onChange:render,onRemote:stream=>{audio.srcObject=stream;if(stream)void audio.play().catch(()=>render(voice.call));},onError:e=>toast(e.message)});
  const click=async e=>{const a=e.target.closest('[data-call-action]')?.dataset.callAction;if(!a)return;try{if(a==='answer'){if(recording())throw new Error('Stop recording your voice note first.');await voice.accept();}if(a==='end')await voice.end();if(a==='mute')voice.mute();if(a==='play')await audio.play();}catch(error){toast(error.message);}};
  host.addEventListener('click',click);
  const closeCamera=()=>{camera?.stop();camera=null;photo=null;if(photoUrl)URL.revokeObjectURL(photoUrl);photoUrl=null;};
  async function openCamera(){
    if(voice.busy)throw new Error('Wait for the call to finish connecting.');
    modal('Take a photo','<div class="camera-view"><video id="camera-video" autoplay playsinline muted></video><img id="camera-photo" class="hidden" alt="Photo preview"></div><p id="camera-error" role="status"></p><div class="modal-actions"><button class="secondary" type="button" data-camera="device">Device camera or photo</button><button class="secondary" type="button" data-camera="flip">Switch camera</button><button class="primary" type="button" data-camera="capture">Take photo</button><button class="secondary hidden" type="button" data-camera="retake">Retake</button><button class="primary hidden" type="button" data-camera="use">Use photo</button></div><input id="camera-input" class="hidden" type="file" accept="image/*" capture="environment">');
    camera=new Camera({devices:navigator.mediaDevices,video:document.querySelector('#camera-video')});
    try{await camera.open();}catch(e){closeCamera();if(!document.querySelector('#camera-error'))return;document.querySelector('#camera-error').textContent=e.name==='NotAllowedError'?'Camera permission was denied. Allow camera access in your browser settings, or choose a photo below.':e.message;}
  }
  const cameraClick=async e=>{
    const action=e.target.closest('[data-camera]')?.dataset.camera;if(!action)return;
    try{
      if(action==='device')document.querySelector('#camera-input').click();
      if(action==='flip')await camera?.flip();
      if(action==='retake'){closeCamera();await openCamera();}
      if(action==='capture'){
        if(!camera)throw new Error('Camera unavailable. Choose “Device camera or photo”.');
        photo=await camera.capture(document);photoUrl=URL.createObjectURL(photo);document.querySelector('#camera-photo').src=photoUrl;
        document.querySelector('#camera-photo').classList.remove('hidden');document.querySelector('#camera-video').classList.add('hidden');
        for(const b of document.querySelectorAll('[data-camera]')){if(['capture','flip','device'].includes(b.dataset.camera))b.classList.add('hidden');if(['retake','use'].includes(b.dataset.camera))b.classList.remove('hidden');}
      }
      if(action==='use'&&photo){const file=photo;dismiss();closeCamera();preview(file);}
    }catch(error){toast(error.message);}
  };
  const cameraInput=e=>{if(e.target.id==='camera-input'&&e.target.files[0]){const file=e.target.files[0];dismiss();closeCamera();preview(file);}};
  document.addEventListener('click',cameraClick);document.addEventListener('change',cameraInput);
  document.querySelector('#modal').addEventListener('close',closeCamera);
  document.querySelector('#modal').addEventListener('cancel',closeCamera);
  async function sync(){
    if(closed||syncing)return;syncing=true;
    try{
      if(voice.ready)await voice.poll();
      const calls=await api('/api/calls');voice.lastGood=Date.now();if(closed)return;
      if(voice.call&&!voice.ready&&!voice.busy&&!calls.some(c=>c.id===voice.call.id)){voice.clean();}
      if(!voice.call){const c=calls.find(c=>c.incoming&&c.status==='ringing');if(c){voice.incoming(c);if(known!==c.id){beep();known=c.id;}}}
    }catch(e){if(e.status===401||e.status===403){voice.clean();}else if(voice.call&&voice.ready&&Date.now()-(voice.lastGood||Date.now())>45000)await voice.fail(new Error('Call server unreachable. Please reconnect.'));}
    finally{syncing=false;}
  }
  const timer=setInterval(()=>{if(voice.call||!document.hidden)void sync();},2000);
  const leave=()=>{if(voice.call)void post('/api/calls',{action:voice.ready?'end':'decline',callId:voice.call.id}).catch(()=>{});voice.clean();closeCamera();};
  window.addEventListener('pagehide',leave);
  return {sync,closeCamera,camera:openCamera,call:async id=>{if(recording())throw new Error('Stop recording your voice note first.');await voice.start(id);},active:()=>Boolean(voice.call||voice.busy),close(){closed=true;clearInterval(timer);leave();host.remove();audio.remove();document.removeEventListener('click',cameraClick);document.removeEventListener('change',cameraInput);document.querySelector('#modal').removeEventListener('close',closeCamera);document.querySelector('#modal').removeEventListener('cancel',closeCamera);window.removeEventListener('pagehide',leave);}};
}
