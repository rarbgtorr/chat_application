-- Permanently remove an authorized message and queue its stored attachment for deletion.
-- The RPC is service-role only; the application session token still determines who may delete.
create or replace function public.wc_message_delete(p_token text,p_room text,p_message text)
returns void language plpgsql set search_path='' as $$
declare
 s public.wc_sessions;
 u public.wc_users;
 r public.wc_rooms;
 m public.wc_messages;
 c public.wc_cycles;
 next_client record;
 who text;
 role_name text;
 last_reply bigint;
 reset_cycle boolean := false;
 had_cycle boolean := false;
begin
 select * into r from public.wc_rooms where id=p_room for update;
 if not found or not public.wc_allowed(p_token,p_room) then raise exception '404|Conversation not found.'; end if;

 select * into s from public.wc_sessions where token_hash=p_token;
 select * into u from public.wc_users where id=s.user_id;
 who:=coalesce(s.user_id,s.room_id);
 role_name:=coalesce(u.role,'client');

 select * into m from public.wc_messages where id=p_message and room_id=p_room for update;
 if not found then raise exception '404|Message not found.'; end if;
 if role_name<>'admin' and m.sender_id<>who then raise exception '403|You can only delete messages you sent.'; end if;

 select * into c from public.wc_cycles where room_id=p_room for update;
 had_cycle:=c.room_id is not null;
 reset_cycle:=had_cycle and c.first_message_id=m.id;
 if reset_cycle then
  delete from public.wc_push_jobs where room_id=p_room and cycle_id=c.first_message_id;
  update public.wc_alerts set seen=true where room_id=p_room and cycle_id=c.first_message_id;
  delete from public.wc_cycles where room_id=p_room;
 end if;

 if m.attachment_id is not null then
  insert into public.wc_deletions(id) values(m.attachment_id) on conflict do nothing;
 end if;
 delete from public.wc_messages where id=m.id and room_id=p_room;
 if m.attachment_id is not null then delete from public.wc_attachments where id=m.attachment_id; end if;

 if reset_cycle and r.status='open' then
  select id,created_at into next_client from public.wc_messages
   where room_id=p_room and sender_role='client' and seq>m.seq order by seq limit 1;
  if next_client.id is not null then
   insert into public.wc_cycles(room_id,first_message_id,first_at)
   values(p_room,next_client.id,next_client.created_at);
  end if;
 elsif not had_cycle and m.sender_role in ('admin','agent') and r.status='open' then
  select coalesce(max(seq),0) into last_reply from public.wc_messages
   where room_id=p_room and sender_role in ('admin','agent');
  select id,created_at into next_client from public.wc_messages
   where room_id=p_room and sender_role='client' and seq>last_reply order by seq limit 1;
  if next_client.id is not null then
   insert into public.wc_cycles(room_id,first_message_id,first_at)
   values(p_room,next_client.id,next_client.created_at);
  end if;
 end if;

 perform public.wc_signal(p_room);
end $$;

revoke all on function public.wc_message_delete(text,text,text) from public,anon,authenticated;
grant execute on function public.wc_message_delete(text,text,text) to service_role;
