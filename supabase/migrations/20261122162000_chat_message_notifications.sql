begin;

CREATE FUNCTION public.wc_notify_message(p_user text, p_client text, p_room text, p_kind text, p_cycle text, p_title text, p_body text, p_message text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
 s record;
 muted boolean;
begin
 muted := exists(select 1 from public.wc_notification_mutes where user_id=p_user and room_id=p_room);
 -- Escalations remain visible in the staff inbox while the member is waiting.
 if p_user is not null and (not muted or p_kind in ('reminder','escalation')) then
  insert into public.wc_alerts(room_id,user_id,kind,cycle_id,body,created_at)
   values(p_room,p_user,p_kind,p_cycle,p_body,public.wc_now());
 end if;
 if muted then return; end if;
 for s in select p.endpoint from public.wc_subscriptions p join public.wc_sessions x on x.token_hash=p.session_hash
 where (p_user is not null and x.user_id=p_user) or (p_client is not null and x.room_id=p_client) loop
 insert into public.wc_push_jobs(endpoint,room_id,cycle_id,kind,payload,next_at,expires_at) values(s.endpoint,p_room,p_cycle,p_kind,
 jsonb_build_object('title',p_title,'body',p_body,'kind',p_kind,'messageId',p_message,'roomId',p_room,'tag',coalesce(p_room,'test')||'-'||p_kind,'url',case when p_client is not null then '/c/'||p_room else '/?room='||coalesce(p_room,'') end),public.wc_now(),public.wc_now()+86400000);
 end loop;
end $function$;

CREATE OR REPLACE FUNCTION public.wc_message(p_token text, p_room text, p_id text, p_body text, p_file text, p_nonce text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare s record; u record; r record; c record; m record; who text; role_name text; a record; sender_name text; begin
 select * into r from public.wc_rooms where id=p_room for update;
 if not found or not public.wc_allowed(p_token,p_room) then raise exception '404|Conversation not found.'; end if;
 if r.status<>'open' then raise exception '409|Conversation is closed.'; end if;
 select * into s from public.wc_sessions where token_hash=p_token;
 select * into u from public.wc_users where id=s.user_id;
 who:=coalesce(s.user_id,s.room_id); role_name:=coalesce(u.role,'client');
 select * into m from public.wc_messages where room_id=p_room and sender_id=who and nonce=p_nonce;
 if found then return jsonb_build_object('id',m.id,'seq',m.seq); end if;
 if p_file is not null and not exists(select 1 from public.wc_attachments f where f.id=p_file and f.room_id=p_room and f.session_hash=p_token and not f.expired and f.expires_at>public.wc_now() and not exists(select 1 from public.wc_messages z where z.attachment_id=f.id)) then raise exception '400|Attachment unavailable.'; end if;
 insert into public.wc_messages(id,room_id,sender_id,sender_role,body,attachment_id,created_at,nonce) values(p_id,p_room,who,role_name,p_body,p_file,public.wc_now(),p_nonce) returning * into m;
 if role_name='client' then
  insert into public.wc_cycles(room_id,first_message_id,first_at)
   values(p_room,p_id,m.created_at) on conflict do nothing;
 else
  delete from public.wc_cycles where room_id=p_room returning * into c;
  delete from public.wc_push_jobs where room_id=p_room and cycle_id=c.first_message_id;
  update public.wc_alerts set seen=true where room_id=p_room and cycle_id=c.first_message_id;
  perform public.wc_notify_message(null,p_room,p_room,'reply',null,
   'Wingfactor Support','You have a new message in your support chat.',m.id);
 end if;
 sender_name:=case when role_name='client' then
  coalesce((select nullif(name,'') from public.wc_contacts where room_id=p_room),r.code)
  else u.name end;
 -- Notify every active staff participant except the sender, including admins of assigned rooms.
 for a in
  select x.id from public.wc_users x where not x.disabled and x.id is distinct from s.user_id
  and (x.role='admin' or (x.role='agent' and exists(
   select 1 from public.wc_assignments z where z.room_id=p_room and z.user_id=x.id)))
 loop
  perform public.wc_notify_message(a.id,null,p_room,'message',null,sender_name,
   'New message in your support chat.',m.id);
 end loop;
 perform public.wc_signal(p_room);
 return jsonb_build_object('id',m.id,'seq',m.seq);
end $function$;

revoke all on function public.wc_notify_message(text,text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.wc_notify_message(text,text,text,text,text,text,text,text) to service_role;

-- Load the inbox in one database request and project contact fields by role.
create function public.wc_room_summaries(p_token text)
returns jsonb language sql stable set search_path='' as $$
 with viewer as (
  select s.room_id,s.user_id,coalesce(u.role,'client') as role
  from public.wc_sessions s left join public.wc_users u on u.id=s.user_id
  where s.token_hash=p_token and (s.room_id is not null or not u.disabled)
 )
 select coalesce(jsonb_agg(
  to_jsonb(r)||jsonb_build_object(
   'last',case when recent.seq is not null then jsonb_build_object(
    'body',case when recent.deleted_at is not null then 'This message was deleted' else coalesce(nullif(recent.body,''),'Attachment') end,
    'created_at',recent.created_at,'sender_role',recent.sender_role,'attachment_id',recent.attachment_id,'deleted_at',recent.deleted_at
   ) end,
   'unread',unread.total,'agents',assigned.agents,'waitingSince',cycle.first_at
  )||case v.role
   when 'admin' then jsonb_build_object('private',to_jsonb(c),'notificationsMuted',m.room_id is not null)
   when 'agent' then jsonb_build_object('client',jsonb_build_object('name',coalesce(c.name,''),'notes',coalesce(c.notes,'')))
   else '{}'::jsonb
  end order by r.created_at desc,r.id
 ),'[]'::jsonb)
 from viewer v
 join public.wc_rooms r on (
  v.role='admin' or r.id=v.room_id or exists(
   select 1 from public.wc_assignments a where a.room_id=r.id and a.user_id=v.user_id
  )
 )
 left join public.wc_contacts c on c.room_id=r.id and v.role<>'client'
 left join public.wc_notification_mutes m on m.room_id=r.id and m.user_id=v.user_id
 left join public.wc_cycles cycle on cycle.room_id=r.id
 left join public.wc_reads marker on marker.room_id=r.id and marker.subject=coalesce(v.user_id,'client:'||v.room_id)
 left join lateral (
  select msg.seq,msg.body,msg.created_at,msg.sender_role,msg.attachment_id,msg.deleted_at
  from public.wc_messages msg where msg.room_id=r.id order by msg.seq desc limit 1
 ) recent on true
 cross join lateral (
  select count(*) as total from public.wc_messages msg
  where msg.room_id=r.id and msg.seq>coalesce(marker.seq,0) and msg.deleted_at is null
   and (case when v.role='client' then msg.sender_role<>'client'
    else msg.sender_role in ('client','admin','agent') and msg.sender_id<>v.user_id end)
 ) unread
 cross join lateral (
  select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name) order by u.name,u.id),'[]'::jsonb) as agents
  from public.wc_assignments a join public.wc_users u on u.id=a.user_id and not u.disabled
  where a.room_id=r.id
 ) assigned;
$$;

-- Browser push has a small payload limit. Fetch the full text after checking current room access.
create function public.wc_notification_body(p_token text,p_room text,p_message text)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object(
  'body',coalesce(nullif(m.body,''),f.filename,'Attachment'),
  'title',case
   when s.room_id is not null then 'Wingfactor Support'
   when m.sender_role='client' then coalesce(nullif(c.name,''),r.code)
   else coalesce(u.name,'Wingfactor Support') end
 )
 from public.wc_messages m
 join public.wc_rooms r on r.id=m.room_id
 join public.wc_sessions s on s.token_hash=p_token
 left join public.wc_attachments f on f.id=m.attachment_id and not f.expired and f.expires_at>public.wc_now()
 left join public.wc_contacts c on c.room_id=m.room_id and s.user_id is not null
 left join public.wc_users u on u.id=m.sender_id and s.user_id is not null
 where m.id=p_message and m.room_id=p_room and m.deleted_at is null
  and public.wc_allowed(p_token,p_room)
  and not exists(select 1 from public.wc_notification_mutes x where x.room_id=p_room and x.user_id=s.user_id);
$$;

create function public.wc_mark_read(p_token text,p_room text,p_seq bigint)
returns void language plpgsql set search_path='' as $$
declare viewer public.wc_sessions; seq_to_mark bigint; written bigint;
begin
 if not public.wc_allowed(p_token,p_room) then raise exception '404|Conversation not found.'; end if;
 select * into viewer from public.wc_sessions where token_hash=p_token;
 select least(coalesce(max(seq),0),greatest(0,p_seq)) into seq_to_mark from public.wc_messages where room_id=p_room;
 if seq_to_mark>0 then
  insert into public.wc_reads as marker(room_id,subject,seq)
  values(p_room,coalesce(viewer.user_id,'client:'||p_room),seq_to_mark)
  on conflict(room_id,subject) do update set seq=excluded.seq where excluded.seq>marker.seq
  returning seq into written;
 end if;
 if viewer.user_id is not null then
  update public.wc_alerts set seen=true
  where room_id=p_room and user_id=viewer.user_id and not seen and kind in ('message','assigned');
 end if;
 if written is not null then perform public.wc_signal(p_room); end if;
end;
$$;

revoke all on function public.wc_room_summaries(text),public.wc_notification_body(text,text,text),public.wc_mark_read(text,text,bigint) from public,anon,authenticated;
grant execute on function public.wc_room_summaries(text),public.wc_notification_body(text,text,text),public.wc_mark_read(text,text,bigint) to service_role;

commit;
