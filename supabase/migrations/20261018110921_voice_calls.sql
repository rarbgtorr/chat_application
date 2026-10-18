-- Audio only. Signaling stays behind the authenticated API; broadcasts contain no SDP.
create table public.wc_calls(
 id text primary key,room_id text not null references public.wc_rooms on delete cascade,
 caller_id text not null,caller_role text not null,caller_session text references public.wc_sessions on delete set null,
 callee_id text,callee_session text references public.wc_sessions on delete set null,
 status text not null check(status in ('ringing','connecting','active','ended','declined','missed','failed','cancelled')),
 created_at bigint not null,accepted_at bigint,connected_at bigint,ended_at bigint,
 caller_seen bigint not null,callee_seen bigint,expires_at bigint not null
);
create unique index wc_calls_one_room on public.wc_calls(room_id) where status in ('ringing','connecting','active');
create index wc_calls_recent on public.wc_calls(created_at);
create index wc_calls_caller_session on public.wc_calls(caller_session);
create index wc_calls_callee_session on public.wc_calls(callee_session);
create table public.wc_call_signals(seq bigint generated always as identity primary key,
 call_id text not null references public.wc_calls on delete cascade,from_session text not null,
 kind text not null check(kind in ('offer','answer','ice')),payload jsonb not null,created_at bigint not null);
create index wc_call_signals_call on public.wc_call_signals(call_id,seq);

create function public.wc_call_finish(p_id text,p_status text) returns void language plpgsql set search_path='' as $$
declare c public.wc_calls; label text; begin
 select * into c from public.wc_calls where id=p_id for update;
 if not found or c.status not in ('ringing','connecting','active') then return; end if;
 update public.wc_calls set status=p_status,ended_at=public.wc_now() where id=p_id;
 label:=case p_status when 'ended' then 'Voice call ended' when 'declined' then 'Voice call declined' when 'cancelled' then 'Voice call cancelled' when 'missed' then 'Missed voice call' else 'Voice call could not connect' end;
 if c.connected_at is not null then label:=label||' · '||greatest(0,(public.wc_now()-c.connected_at)/1000)::text||' seconds'; end if;
 insert into public.wc_messages(id,room_id,sender_id,sender_role,body,created_at,nonce)
 values('call-'||c.id,c.room_id,'system','system',label,public.wc_now(),'call-'||c.id) on conflict do nothing;
 delete from public.wc_push_jobs where kind='call' and cycle_id=c.id;
 update public.wc_alerts set seen=true where kind='call' and cycle_id=c.id;
 perform public.wc_signal(c.room_id);
end $$;
create function public.wc_calls_sweep() returns void language plpgsql set search_path='' as $$
declare c public.wc_calls; begin
 -- Serialize transitions across rooms as well as across devices of one user.
 perform pg_advisory_xact_lock(78261441);
 for c in select * from public.wc_calls where status in ('ringing','connecting','active') for update loop
 if c.caller_session is null or not public.wc_allowed(c.caller_session,c.room_id)
 or (c.status<>'ringing' and (c.callee_session is null or not public.wc_allowed(c.callee_session,c.room_id)))
 or not exists(select 1 from public.wc_rooms where id=c.room_id and status='open') then
 perform public.wc_call_finish(c.id,'ended');
 elsif (c.status='ringing' and c.expires_at<=public.wc_now()) then perform public.wc_call_finish(c.id,'missed');
 elsif (c.status='connecting' and c.expires_at<=public.wc_now()) or c.caller_seen<public.wc_now()-90000
 or (c.status='active' and c.callee_seen<public.wc_now()-90000) then perform public.wc_call_finish(c.id,'failed'); end if;
 end loop;
 delete from public.wc_call_signals where call_id in (select id from public.wc_calls where ended_at<public.wc_now()-3600000);
end $$;
create function public.wc_call_api(p_token text,p_action text,p_call text default null,p_room text default null,p_payload jsonb default '{}',p_after bigint default 0)
 returns jsonb language plpgsql set search_path='' as $$
declare s public.wc_sessions; u public.wc_users; c public.wc_calls; who text; role_name text; opposite boolean; participant boolean; a record; sig jsonb; begin
 perform public.wc_calls_sweep();
 select * into s from public.wc_sessions where token_hash=p_token;
 select * into u from public.wc_users where id=s.user_id;
 if s.token_hash is null or u.disabled then raise exception '401|Please sign in again.'; end if;
 who:=coalesce(s.user_id,s.room_id); role_name:=coalesce(u.role,'client');
 if p_action='list' then
 return coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'roomId',x.room_id,'status',x.status,'incoming',x.caller_session<>p_token,'createdAt',x.created_at,'connectedAt',x.connected_at,'expiresAt',x.expires_at))
 from public.wc_calls x where x.status in ('ringing','connecting','active') and public.wc_allowed(p_token,x.room_id) and
 (x.caller_session=p_token or x.callee_session=p_token or (x.status='ringing' and ((x.caller_role='client')<>(role_name='client'))))), '[]');
 end if;
 if p_action='start' then
 if not public.wc_allowed(p_token,p_room) or not exists(select 1 from public.wc_rooms where id=p_room and status='open') then raise exception '404|Open conversation not found.'; end if;
 select * into c from public.wc_calls where id=p_call;
 if found then
 if c.caller_session<>p_token or c.room_id<>p_room then raise exception '409|Call identifier already used.'; end if;
 else
 if exists(select 1 from public.wc_calls where status in ('ringing','connecting','active') and (room_id=p_room or caller_id=who or callee_id=who)) then raise exception '409|A call is already in progress.'; end if;
 if length(p_call) not between 10 and 100 or p_payload->>'type'<>'offer' or length(coalesce(p_payload->>'sdp','')) not between 1 and 24000 then raise exception '400|Invalid call offer.'; end if;
 insert into public.wc_calls(id,room_id,caller_id,caller_role,caller_session,status,created_at,caller_seen,expires_at)
 values(p_call,p_room,who,role_name,p_token,'ringing',public.wc_now(),public.wc_now(),public.wc_now()+60000) returning * into c;
 insert into public.wc_call_signals(call_id,from_session,kind,payload,created_at) values(c.id,p_token,'offer',p_payload,public.wc_now());
 if role_name='client' then
 for a in select x.id from public.wc_users x where not x.disabled and ((x.role='agent' and exists(select 1 from public.wc_assignments z where z.room_id=p_room and z.user_id=x.id)) or (x.role='admin' and not exists(select 1 from public.wc_assignments z join public.wc_users y on y.id=z.user_id where z.room_id=p_room and not y.disabled))) loop
 perform public.wc_notify(a.id,null,p_room,'call',c.id,'Incoming support call','Open your support chat to answer.'); end loop;
 else perform public.wc_notify(null,p_room,p_room,'call',c.id,'Wingfactor Support is calling','Open your support chat to answer.'); end if;
 update public.wc_push_jobs set expires_at=c.expires_at,payload=payload||jsonb_build_object('callId',c.id) where kind='call' and cycle_id=c.id;
 perform public.wc_signal(c.room_id);
 end if;
 else
 select * into c from public.wc_calls where id=p_call for update;
 end if;
 if c.id is null or not public.wc_allowed(p_token,c.room_id) then raise exception '404|Call not found.'; end if;
 participant:=p_token=c.caller_session or p_token=c.callee_session;
 opposite:=((c.caller_role='client')<>(role_name='client'));
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
 return jsonb_build_object('id',c.id,'roomId',c.room_id,'status',c.status,'incoming',c.caller_session is distinct from p_token,'createdAt',c.created_at,'connectedAt',c.connected_at,'expiresAt',c.expires_at,'signals',sig);
end $$;

alter table public.wc_calls enable row level security;
alter table public.wc_call_signals enable row level security;
create policy wc_server_only on public.wc_calls for all to anon,authenticated using(false) with check(false);
create policy wc_server_only on public.wc_call_signals for all to anon,authenticated using(false) with check(false);
revoke all on public.wc_calls,public.wc_call_signals from anon,authenticated;
grant all on public.wc_calls,public.wc_call_signals to service_role;
grant usage,select on sequence public.wc_call_signals_seq_seq to service_role;
revoke all on function public.wc_call_finish(text,text),public.wc_calls_sweep(),public.wc_call_api(text,text,text,text,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.wc_call_finish(text,text),public.wc_calls_sweep(),public.wc_call_api(text,text,text,text,jsonb,bigint) to service_role;
