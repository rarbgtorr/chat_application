-- Per-tab visibility and typing leases. No message content or contact identity is stored.
create table public.wc_activity (
 session_hash text not null references public.wc_sessions(token_hash) on delete cascade,
 tab_id text not null,
 room_id text not null references public.wc_rooms(id) on delete cascade,
 expires_at bigint not null,
 typing_until bigint not null default 0,
 primary key(session_hash,tab_id)
);
create index wc_activity_room on public.wc_activity(room_id);
create index wc_activity_expiry on public.wc_activity(expires_at);
alter table public.wc_activity enable row level security;
create policy wc_activity_server_only on public.wc_activity for all to anon,authenticated using(false) with check(false);
revoke all on public.wc_activity from public,anon,authenticated;
grant all on public.wc_activity to service_role;

create function public.wc_typing_signal(p_room text,p_subject text,p_role text)
returns void language plpgsql set search_path='' as $$
declare recipient record; until_at bigint; now_ms bigint := public.wc_now();
begin
 select coalesce(max(a.typing_until),0) into until_at
 from public.wc_activity a join public.wc_sessions s on s.token_hash=a.session_hash
 where a.room_id=p_room and a.expires_at>now_ms and coalesce(s.user_id,s.room_id)=p_subject
 and public.wc_allowed(s.token_hash,p_room);
 for recipient in select s.live_key from public.wc_sessions s
 where coalesce(s.user_id,s.room_id)<>p_subject and public.wc_allowed(s.token_hash,p_room) loop
  perform realtime.send(jsonb_build_object('roomId',p_room,'subject',p_subject,'role',p_role,
   'typing',until_at>now_ms,'ttl',greatest(0,least(6000,until_at-now_ms))),
   'typing',recipient.live_key,false);
 end loop;
end $$;

create function public.wc_activity_set(p_token text,p_tab text,p_room text,p_active boolean,p_typing boolean)
returns void language plpgsql set search_path='' as $$
declare s public.wc_sessions; u public.wc_users; old_activity public.wc_activity;
 now_ms bigint := public.wc_now(); who text; role_name text;
begin
 if p_tab is null or p_tab !~ '^[a-zA-Z0-9_-]{10,100}$' then raise exception '400|Invalid tab identifier.'; end if;
 if not public.wc_allowed(p_token,p_room) then raise exception '404|Conversation not found.'; end if;
 select * into s from public.wc_sessions where token_hash=p_token;
 select * into u from public.wc_users where id=s.user_id;
 who:=coalesce(s.user_id,s.room_id);role_name:=coalesce(u.role,'client');
 select * into old_activity from public.wc_activity where session_hash=p_token and tab_id=p_tab;
 delete from public.wc_activity where expires_at<now_ms;
 if p_active then
  insert into public.wc_activity(session_hash,tab_id,room_id,expires_at,typing_until)
  values(p_token,p_tab,p_room,now_ms+30000,case when p_typing and exists(select 1 from public.wc_rooms where id=p_room and status='open') then now_ms+6000 else 0 end)
  on conflict(session_hash,tab_id) do update set room_id=excluded.room_id,expires_at=excluded.expires_at,typing_until=excluded.typing_until;
 else
  delete from public.wc_activity where session_hash=p_token and tab_id=p_tab;
 end if;
 if old_activity.room_id is not null and old_activity.room_id<>p_room and old_activity.typing_until>now_ms then
  perform public.wc_typing_signal(old_activity.room_id,who,role_name);
 end if;
 if p_typing or old_activity.typing_until>now_ms then
  perform public.wc_typing_signal(p_room,who,role_name);
 end if;
end $$;
revoke all on function public.wc_typing_signal(text,text,text) from public,anon,authenticated;
revoke all on function public.wc_activity_set(text,text,text,boolean,boolean) from public,anon,authenticated;
grant execute on function public.wc_typing_signal(text,text,text) to service_role;
grant execute on function public.wc_activity_set(text,text,text,boolean,boolean) to service_role;
