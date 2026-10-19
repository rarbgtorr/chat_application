-- Include the notification kind so service workers can acknowledge message delivery
-- and keep call notifications visible until the assigned teammate responds.
create or replace function public.wc_notify(p_user text,p_client text,p_room text,p_kind text,p_cycle text,p_title text,p_body text) returns void language plpgsql set search_path='' as $$
declare s record; begin
 if p_user is not null then insert into public.wc_alerts(room_id,user_id,kind,cycle_id,body,created_at) values(p_room,p_user,p_kind,p_cycle,p_body,public.wc_now()); end if;
 for s in select p.endpoint from public.wc_subscriptions p join public.wc_sessions x on x.token_hash=p.session_hash
 where (p_user is not null and x.user_id=p_user) or (p_client is not null and x.room_id=p_client) loop
 insert into public.wc_push_jobs(endpoint,room_id,cycle_id,kind,payload,next_at,expires_at) values(s.endpoint,p_room,p_cycle,p_kind,
 jsonb_build_object('title',p_title,'body',p_body,'kind',p_kind,'roomId',p_room,'tag',coalesce(p_room,'test')||'-'||p_kind,'url',case when p_client is not null then '/c/'||p_room else '/?room='||coalesce(p_room,'') end),public.wc_now(),public.wc_now()+86400000);
 end loop;
end $$;

-- Only the active assigned teammate can see, accept, or decline a client's call.
-- Administrators are the fallback when a room has no active assigned teammate.
create or replace function public.wc_call_api(p_token text,p_action text,p_call text default null,p_room text default null,p_payload jsonb default '{}',p_after bigint default 0)
 returns jsonb language plpgsql set search_path='' as $$
declare s public.wc_sessions; u public.wc_users; c public.wc_calls; who text; role_name text; media_name text; opposite boolean; participant boolean; a record; sig jsonb; begin
 perform public.wc_calls_sweep();
 select * into s from public.wc_sessions where token_hash=p_token;
 select * into u from public.wc_users where id=s.user_id;
 if s.token_hash is null or u.disabled then raise exception '401|Please sign in again.'; end if;
 who:=coalesce(s.user_id,s.room_id); role_name:=coalesce(u.role,'client');
 if p_action='list' then
 return coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'roomId',x.room_id,'status',x.status,'media',x.media,'incoming',x.caller_session<>p_token,'createdAt',x.created_at,'connectedAt',x.connected_at,'expiresAt',x.expires_at))
 from public.wc_calls x where x.status in ('ringing','connecting','active') and public.wc_allowed(p_token,x.room_id) and
 (x.caller_session=p_token or x.callee_session=p_token or (x.status='ringing' and ((x.caller_role='client')<>(role_name='client')) and
 (x.caller_role<>'client' or role_name='agent' or not exists(select 1 from public.wc_assignments z join public.wc_users y on y.id=z.user_id where z.room_id=x.room_id and not y.disabled))))), '[]');
 end if;
 if p_action='start' then
 if not public.wc_allowed(p_token,p_room) or not exists(select 1 from public.wc_rooms where id=p_room and status='open') then raise exception '404|Open conversation not found.'; end if;
 select * into c from public.wc_calls where id=p_call;
 if found then
 if c.caller_session<>p_token or c.room_id<>p_room then raise exception '409|Call identifier already used.'; end if;
 else
 if exists(select 1 from public.wc_calls where status in ('ringing','connecting','active') and (room_id=p_room or caller_id=who or callee_id=who)) then raise exception '409|A call is already in progress.'; end if;
 media_name:=coalesce(nullif(p_payload->>'media',''),'voice');
 if media_name not in ('voice','video') or length(p_call) not between 10 and 100 or p_payload->>'type'<>'offer' or length(coalesce(p_payload->>'sdp','')) not between 1 and 24000 then raise exception '400|Invalid call offer.'; end if;
 insert into public.wc_calls(id,room_id,caller_id,caller_role,caller_session,status,media,created_at,caller_seen,expires_at)
 values(p_call,p_room,who,role_name,p_token,'ringing',media_name,public.wc_now(),public.wc_now(),public.wc_now()+60000) returning * into c;
 insert into public.wc_call_signals(call_id,from_session,kind,payload,created_at) values(c.id,p_token,'offer',p_payload,public.wc_now());
 if role_name='client' then
 for a in select x.id from public.wc_users x where not x.disabled and ((x.role='agent' and exists(select 1 from public.wc_assignments z where z.room_id=p_room and z.user_id=x.id)) or (x.role='admin' and not exists(select 1 from public.wc_assignments z join public.wc_users y on y.id=z.user_id where z.room_id=p_room and not y.disabled))) loop
 perform public.wc_notify(a.id,null,p_room,'call',c.id,'Incoming '||media_name||' call','Open your support chat to answer.'); end loop;
 else perform public.wc_notify(null,p_room,p_room,'call',c.id,'Wingfactor Support is calling','Open your support chat to answer the '||media_name||' call.'); end if;
 update public.wc_push_jobs set expires_at=c.expires_at,payload=payload||jsonb_build_object('callId',c.id,'media',c.media) where kind='call' and cycle_id=c.id;
 perform public.wc_signal(c.room_id);
 end if;
 else
 select * into c from public.wc_calls where id=p_call for update;
 end if;
 if c.id is null or not public.wc_allowed(p_token,c.room_id) then raise exception '404|Call not found.'; end if;
 participant:=p_token=c.caller_session or p_token=c.callee_session;
 opposite:=((c.caller_role='client')<>(role_name='client'));
 if p_action in ('accept','decline') and c.caller_role='client' and role_name='admin' and exists(select 1 from public.wc_assignments z join public.wc_users y on y.id=z.user_id where z.room_id=c.room_id and not y.disabled) then raise exception '404|Call not found.'; end if;
 if p_action='accept' then
 if c.status='ringing' and opposite then
 if exists(select 1 from public.wc_calls where id<>c.id and status in ('ringing','connecting','active') and (caller_id=who or callee_id=who)) then raise exception '409|You are already in another call.'; end if;
 update public.wc_calls set callee_id=who,callee_session=p_token,status='connecting',accepted_at=public.wc_now(),callee_seen=public.wc_now(),expires_at=public.wc_now()+45000 where id=c.id returning * into c;
 participant:=true; delete from public.wc_push_jobs where kind='call' and cycle_id=c.id;
 update public.wc_alerts set seen=true where kind='call' and cycle_id=c.id; perform public.wc_signal(c.room_id);
 elsif c.callee_session is distinct from p_token or c.status not in ('connecting','active') then raise exception '409|This call was answered elsewhere or has ended.'; end if;
 elsif p_action='decline' then
 if not opposite or c.status<>'ringing' then raise exception '409|Call is no longer ringing.'; end if;
 perform public.wc_call_finish(c.id,'declined');
 elsif p_action in ('end','connected','signal','poll','start') then
 if not coalesce(participant,false) then raise exception '403|Only the two call devices can access signaling.'; end if;
 if p_action='end' then perform public.wc_call_finish(c.id,case when c.status='ringing' then 'cancelled' when p_payload->>'failed'='true' then 'failed' else 'ended' end);
 elsif p_action='connected' and c.status='connecting' then update public.wc_calls set status='active',connected_at=public.wc_now() where id=c.id; perform public.wc_signal(c.room_id);
 elsif p_action='signal' then
 if c.status not in ('ringing','connecting','active') then raise exception '409|Call has ended.'; end if;
 if (p_payload->>'kind'='answer' and p_token=c.callee_session and p_payload->'data'->>'type'='answer' and length(coalesce(p_payload->'data'->>'sdp','')) between 1 and 24000)
 or (p_payload->>'kind'='ice' and jsonb_typeof(p_payload->'data')='object' and length(coalesce(p_payload->'data'->>'candidate','')) between 1 and 4000) then
 if (select count(*) from public.wc_call_signals where call_id=c.id)>=300 then raise exception '429|Too many call signals.'; end if;
 insert into public.wc_call_signals(call_id,from_session,kind,payload,created_at) values(c.id,p_token,p_payload->>'kind',p_payload->'data',public.wc_now()); perform public.wc_signal(c.room_id);
 else raise exception '400|Invalid call signal.'; end if;
 end if;
 else raise exception '400|Unknown call action.'; end if;
 if coalesce(participant,false) then
 update public.wc_calls set caller_seen=case when caller_session=p_token then public.wc_now() else caller_seen end,callee_seen=case when callee_session=p_token then public.wc_now() else callee_seen end where id=c.id;
 select coalesce(jsonb_agg(jsonb_build_object('seq',seq,'kind',kind,'data',payload) order by seq),'[]') into sig from public.wc_call_signals where call_id=c.id and seq>p_after and from_session<>p_token;
 else sig:='[]'; end if;
 select * into c from public.wc_calls where id=c.id;
 return jsonb_build_object('id',c.id,'roomId',c.room_id,'status',c.status,'media',c.media,'incoming',c.caller_session is distinct from p_token,'createdAt',c.created_at,'connectedAt',c.connected_at,'expiresAt',c.expires_at,'signals',sig);
end $$;

revoke all on function public.wc_notify(text,text,text,text,text,text,text),public.wc_call_api(text,text,text,text,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.wc_notify(text,text,text,text,text,text,text),public.wc_call_api(text,text,text,text,jsonb,bigint) to service_role;
