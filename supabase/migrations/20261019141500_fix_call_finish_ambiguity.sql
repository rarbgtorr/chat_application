-- Avoid a PL/pgSQL variable/column collision while completing voice and video calls.
create or replace function public.wc_call_finish(p_id text,p_status text) returns void language plpgsql set search_path='' as $$
declare c public.wc_calls; label text; call_kind text; begin
 select * into c from public.wc_calls where id=p_id for update;
 if not found or c.status not in ('ringing','connecting','active') then return; end if;
 update public.wc_calls set status=p_status,ended_at=public.wc_now() where id=p_id;
 call_kind:=case when c.media='video' then 'Video' else 'Voice' end;
 label:=case p_status when 'ended' then call_kind||' call ended' when 'declined' then call_kind||' call declined' when 'cancelled' then call_kind||' call cancelled' when 'missed' then 'Missed '||lower(call_kind)||' call' else call_kind||' call could not connect' end;
 if c.connected_at is not null then label:=label||' · '||greatest(0,(public.wc_now()-c.connected_at)/1000)::text||' seconds'; end if;
 insert into public.wc_messages(id,room_id,sender_id,sender_role,body,created_at,nonce)
 values('call-'||c.id,c.room_id,'system','system',label,public.wc_now(),'call-'||c.id) on conflict do nothing;
 delete from public.wc_push_jobs as j where j.kind='call' and j.cycle_id=c.id;
 update public.wc_alerts as a set seen=true where a.kind='call' and a.cycle_id=c.id;
 perform public.wc_signal(c.room_id);
end $$;

revoke all on function public.wc_call_finish(text,text) from public,anon,authenticated;
grant execute on function public.wc_call_finish(text,text) to service_role;
