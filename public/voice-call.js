// One audio/video peer per browser. The API is the only transport for SDP and ICE.
export class VoiceCall {
  constructor({request,mediaDevices,PeerConnection,config,onChange=()=>{},onRemote=()=>{},onLocal=()=>{},onError=()=>{}}) {
    Object.assign(this,{request,mediaDevices,PeerConnection,config,onChange,onRemote,onLocal,onError});
    this.call=null;this.pc=null;this.stream=null;this.after=0;this.remoteIce=[];this.localIce=[];this.sending=Promise.resolve();this.generation=0;this.busy=false;
  }
  emit(){const audio=this.stream?.getAudioTracks?.()||[],video=this.stream?.getVideoTracks?.()||[];this.onChange(this.call?{...this.call,muted:Boolean(audio.length)&&audio.every(t=>!t.enabled),cameraOff:Boolean(video.length)&&video.every(t=>!t.enabled)}:null);}
  async action(action,payload={}){return this.request({action,callId:this.call.id,roomId:this.call.roomId,payload,after:this.after});}
  async prepare(media='voice'){
    if(!this.mediaDevices?.getUserMedia||!this.PeerConnection)throw new Error('Calls need a supported browser with microphone and camera access over HTTPS.');
    const generation=++this.generation;
    const stream=await this.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:media==='video'?{facingMode:'user',width:{ideal:1280},height:{ideal:720}}:false});
    if(generation!==this.generation){stream.getTracks().forEach(t=>t.stop());throw new Error('Call cancelled.');}
    this.stream=stream;this.onLocal(media==='video'?stream:null);
    try{
      this.pc=new this.PeerConnection(this.config);const pc=this.pc;
      stream.getTracks().forEach(track=>pc.addTrack(track,stream));
      pc.ontrack=e=>{if(pc===this.pc)this.onRemote(e.streams[0]);};
      pc.onicecandidate=e=>{if(pc!==this.pc||!e.candidate)return;this.localIce.push(e.candidate.toJSON());if(this.ready)this.flushIce();};
      pc.onconnectionstatechange=()=>{
        if(pc!==this.pc)return;
        clearTimeout(this.disconnected);
        if(pc.connectionState==='connected')void this.action('connected').then(c=>this.consume(c)).catch(e=>this.fail(e));
        if(pc.connectionState==='failed')void this.fail(new Error('Call connection failed. This network may need a TURN relay.'));
        if(pc.connectionState==='disconnected')this.disconnected=setTimeout(()=>void this.fail(new Error('Call disconnected. Check your internet connection.')),12000);
      };
    }catch(e){this.clean();throw e;}
  }
  flushIce(){
    const id=this.call?.id;
    for(const data of this.localIce.splice(0))this.sending=this.sending.then(async()=>{
      if(this.call?.id===id&&this.ready)await this.action('signal',{kind:'ice',data});
    }).catch(e=>void this.fail(e));
  }
  async start(roomId,media='voice'){
    if(this.call||this.busy)throw new Error('Finish the current call first.');this.busy=true;
    try{
      if(!['voice','video'].includes(media))throw new Error('Unsupported call type.');
      await this.prepare(media);this.call={id:crypto.randomUUID(),roomId,status:'preparing',incoming:false,media};this.emit();
      const offer=await this.pc.createOffer();await this.pc.setLocalDescription(offer);
      const call=await this.action('start',{type:offer.type,sdp:offer.sdp,media});this.ready=true;await this.consume(call);this.flushIce();
    }catch(e){if(this.call)try{await this.action('end',{failed:true});}catch{}this.clean();throw e;}finally{this.busy=false;}
  }
  incoming(call){if(!this.call){this.call={media:'voice',...call};this.emit();}}
  async accept(){
    if(this.busy||!this.call?.incoming||this.call.status!=='ringing')return;this.busy=true;const id=this.call.id;
    try{
      await this.prepare(this.call.media||'voice');if(this.call?.id!==id)throw new Error('Call has ended.');
      const call=await this.action('accept');this.ready=true;await this.consume(call);
      if(!this.pc?.remoteDescription)throw new Error('Call offer unavailable. Please try again.');
      const answer=await this.pc.createAnswer();await this.pc.setLocalDescription(answer);
      await this.action('signal',{kind:'answer',data:{type:answer.type,sdp:answer.sdp}});this.flushIce();
    }catch(e){if(this.ready)try{await this.action('end',{failed:true});}catch{}this.clean();throw e;}finally{this.busy=false;}
  }
  async consume(call){
    if(!this.call||call.id!==this.call.id)return;
    const media=call.media||this.call.media||'voice';this.call={...call,media};
    if(!['ringing','connecting','active','preparing'].includes(call.status)){this.clean();return;}
    for(const signal of call.signals||[]){
      if(signal.seq<=this.after)continue;
      if(signal.kind==='offer'||signal.kind==='answer'){
        if(this.pc&&!this.pc.remoteDescription){await this.pc.setRemoteDescription(signal.data);for(const ice of this.remoteIce.splice(0))await this.pc.addIceCandidate(ice);}
      }else if(this.pc?.remoteDescription)await this.pc.addIceCandidate(signal.data);else this.remoteIce.push(signal.data);
      this.after=signal.seq;
    }
    this.emit();
  }
  async poll(){if(!this.call||!this.ready||this.polling||this.busy)return;this.polling=true;try{await this.consume(await this.action('poll'));}finally{this.polling=false;}}
  mute(){if(!this.stream)return;const muted=this.stream.getAudioTracks().every(t=>!t.enabled);this.stream.getAudioTracks().forEach(t=>{t.enabled=muted;});this.emit();}
  toggleCamera(){const tracks=this.stream?.getVideoTracks?.()||[];if(!tracks.length)return;const off=tracks.every(t=>!t.enabled);tracks.forEach(t=>{t.enabled=off;});this.emit();}
  async end(){const action=this.call?.incoming&&!this.ready?'decline':'end';try{if(this.call)await this.action(action);}finally{this.clean();}}
  async fail(error){if(this.failing)return;this.failing=true;try{if(this.call&&this.ready)await this.action('end',{failed:true});}catch{}finally{this.clean();this.onError(error);this.failing=false;}}
  clean(){
    ++this.generation;clearTimeout(this.disconnected);const pc=this.pc;this.pc=null;
    if(pc){pc.ontrack=null;pc.onicecandidate=null;pc.onconnectionstatechange=null;pc.close();}
    this.stream?.getTracks().forEach(t=>t.stop());this.stream=null;this.call=null;this.ready=false;this.after=0;this.remoteIce=[];this.localIce=[];this.onRemote(null);this.onLocal(null);this.emit();
  }
}
