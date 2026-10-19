-- Chat-only objects. All application data is inaccessible to anon/authenticated API clients.
create table public.wc_users(id text primary key,username text unique not null,name text not null,role text not null check(role in ('admin','agent')),password text not null,disabled boolean not null default false);
create table public.wc_rooms(id text primary key,code text unique not null,status text not null default 'open' check(status in ('open','closed')),created_at bigint not null);
create table public.wc_contacts(room_id text primary key references public.wc_rooms on delete cascade,name text not null default '',contact text not null default '',notes text not null default '');
create table public.wc_assignments(room_id text references public.wc_rooms on delete cascade,user_id text references public.wc_users on delete cascade,primary key(room_id,user_id));
create index wc_assignments_user on public.wc_assignments(user_id);
create table public.wc_keys(key_hash text primary key,room_id text not null references public.wc_rooms on delete cascade);
create table public.wc_sessions(token_hash text primary key,user_id text references public.wc_users on delete cascade,room_id text references public.wc_rooms on delete cascade,live_key text not null,created_at bigint not null,check((user_id is null)<>(room_id is null)));
create index wc_sessions_user on public.wc_sessions(user_id);
create index wc_sessions_room on public.wc_sessions(room_id);
create table public.wc_attachments(id text primary key,room_id text not null references public.wc_rooms on delete cascade,session_hash text not null,filename text not null,mime text not null,size bigint not null,created_at bigint not null,expires_at bigint not null,expired boolean not null default false);
create index wc_attachment_expiry on public.wc_attachments(expires_at) where not expired;
create table public.wc_messages(seq bigint generated always as identity primary key,id text unique not null,room_id text not null references public.wc_rooms on delete cascade,sender_id text not null,sender_role text not null,body text not null default '',attachment_id text references public.wc_attachments on delete set null,created_at bigint not null,nonce text not null,unique(room_id,sender_id,nonce));
create index wc_messages_room_seq on public.wc_messages(room_id,seq);
create table public.wc_reads(room_id text references public.wc_rooms on delete cascade,subject text not null,seq bigint not null,primary key(room_id,subject));
create table public.wc_cycles(room_id text primary key references public.wc_rooms on delete cascade,first_message_id text not null,first_at bigint not null,reminded_at bigint,escalated_at bigint);
create table public.wc_subscriptions(endpoint text primary key,session_hash text not null references public.wc_sessions on delete cascade,subscription jsonb not null,created_at bigint not null);
create index wc_sub_session on public.wc_subscriptions(session_hash);
create table public.wc_alerts(id uuid primary key default gen_random_uuid(),room_id text references public.wc_rooms on delete cascade,user_id text not null references public.wc_users on delete cascade,kind text not null,cycle_id text,body text not null,created_at bigint not null,seen boolean not null default false);
create index wc_alert_user on public.wc_alerts(user_id,created_at);
create table public.wc_push_jobs(id uuid primary key default gen_random_uuid(),endpoint text not null references public.wc_subscriptions on delete cascade,room_id text references public.wc_rooms on delete cascade,cycle_id text,kind text not null,payload jsonb not null,next_at bigint not null,attempts int not null default 0,expires_at bigint not null,leased_until bigint not null default 0);
create index wc_push_due on public.wc_push_jobs(next_at);
create table public.wc_deletions(id text primary key);
create table public.wc_settings(key text primary key,value jsonb not null);
create table public.wc_limits(key text primary key,count int not null,reset_at bigint not null);

create function public.wc_now() returns bigint language sql stable set search_path='' as $$ select (extract(epoch from now())*1000)::bigint $$;
create function public.wc_allowed(p_token text,p_room text) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.wc_sessions s left join public.wc_users u on u.id=s.user_id
 where s.token_hash=p_token and ((s.room_id=p_room) or (not u.disabled and (u.role='admin' or exists(select 1 from public.wc_assignments a where a.room_id=p_room and a.user_id=u.id)))))
$$;
create function public.wc_signal(p_room text default null) returns void language plpgsql set search_path='' as $$
declare s record; begin
 for s in select x.live_key from public.wc_sessions x left join public.wc_users u on x.user_id=u.id
 where (x.user_id is null or not u.disabled) and (p_room is null or public.wc_allowed(x.token_hash,p_room)) loop
  perform realtime.send('{}'::jsonb,'change',s.live_key,false);
 end loop;
end $$;
create function public.wc_rate(p_key text,p_max int,p_window bigint) returns boolean language plpgsql set search_path='' as $$
declare n int; begin
 insert into public.wc_limits as l values(p_key,1,public.wc_now()+p_window)
 on conflict(key) do update set count=case when l.reset_at<public.wc_now() then 1 else l.count+1 end,
 reset_at=case when l.reset_at<public.wc_now() then public.wc_now()+p_window else l.reset_at end returning count into n;
 return n<=p_max;
end $$;
create function public.wc_notify(p_user text,p_client text,p_room text,p_kind text,p_cycle text,p_title text,p_body text) returns void language plpgsql set search_path='' as $$
declare s record; begin
 if p_user is not null then insert into public.wc_alerts(room_id,user_id,kind,cycle_id,body,created_at) values(p_room,p_user,p_kind,p_cycle,p_body,public.wc_now()); end if;
 for s in select p.endpoint from public.wc_subscriptions p join public.wc_sessions x on x.token_hash=p.session_hash
 where (p_user is not null and x.user_id=p_user) or (p_client is not null and x.room_id=p_client) loop
 insert into public.wc_push_jobs(endpoint,room_id,cycle_id,kind,payload,next_at,expires_at) values(s.endpoint,p_room,p_cycle,p_kind,
 jsonb_build_object('title',p_title,'body',p_body,'kind',p_kind,'roomId',p_room,'tag',coalesce(p_room,'test')||'-'||p_kind,'url',case when p_client is not null then '/c/'||p_room else '/?room='||coalesce(p_room,'') end),public.wc_now(),public.wc_now()+86400000);
 end loop;
end $$;
create function public.wc_message(p_token text,p_room text,p_id text,p_body text,p_file text,p_nonce text) returns jsonb language plpgsql set search_path='' as $$
declare s record; u record; r record; c record; m record; who text; role_name text; a record; begin
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
 insert into public.wc_cycles(room_id,first_message_id,first_at) values(p_room,p_id,public.wc_now()) on conflict do nothing;
 for a in select x.id from public.wc_users x where not x.disabled and ((x.role='agent' and exists(select 1 from public.wc_assignments z where z.room_id=p_room and z.user_id=x.id)) or (x.role='admin' and not exists(select 1 from public.wc_assignments z join public.wc_users y on y.id=z.user_id where z.room_id=p_room and not y.disabled))) loop
 perform public.wc_notify(a.id,null,p_room,'message',null,'New message · '||r.code,'A client sent a message or attachment.'); end loop;
 else
 select * into c from public.wc_cycles where room_id=p_room;
 delete from public.wc_push_jobs where room_id=p_room and cycle_id=c.first_message_id;
 update public.wc_alerts set seen=true where room_id=p_room and cycle_id=c.first_message_id;
 delete from public.wc_cycles where room_id=p_room;
 perform public.wc_notify(null,p_room,p_room,'reply',null,'Wingfactor Support replied','You have a new message in your support chat.');
 end if;
 perform public.wc_signal(p_room);
 return jsonb_build_object('id',m.id,'seq',m.seq);
end $$;
create function public.wc_schedule() returns void language plpgsql set search_path='' as $$
declare r record; c record; u record; begin
 for r in select x.* from public.wc_rooms x join public.wc_cycles y on y.room_id=x.id where x.status='open' for update of x skip locked loop
 select * into c from public.wc_cycles where room_id=r.id;
 if c.reminded_at is null and public.wc_now()-c.first_at>=300000 then
 for u in select x.id from public.wc_users x join public.wc_assignments a on a.user_id=x.id where a.room_id=r.id and not x.disabled loop
 perform public.wc_notify(u.id,null,r.id,'reminder',c.first_message_id,'Reply needed · '||r.code,'This client has been waiting at least 5 minutes. Please reply.'); end loop;
 update public.wc_cycles set reminded_at=public.wc_now() where room_id=r.id;
 end if;
 if c.escalated_at is null and public.wc_now()-c.first_at>=600000 then
 for u in select id from public.wc_users where role='admin' and not disabled loop
 perform public.wc_notify(u.id,null,r.id,'escalation',c.first_message_id,'Client waiting · '||r.code,'No teammate reply for at least 10 minutes. Please check this conversation.'); end loop;
 update public.wc_cycles set escalated_at=public.wc_now() where room_id=r.id;
 end if;
 end loop;
 -- Retain attachment metadata and chat text while queuing expired objects for Storage API deletion.
 insert into public.wc_deletions select id from public.wc_attachments where not expired and expires_at<=public.wc_now() on conflict do nothing;
 update public.wc_attachments set expired=true where not expired and expires_at<=public.wc_now();
 delete from public.wc_push_jobs where expires_at<public.wc_now();
 delete from public.wc_limits where reset_at<public.wc_now()-86400000;
end $$;
create function public.wc_claim_jobs() returns setof public.wc_push_jobs language sql set search_path='' as $$
 update public.wc_push_jobs set leased_until=public.wc_now()+60000 where id in
 (select id from public.wc_push_jobs where next_at<=public.wc_now() and leased_until<public.wc_now() order by next_at limit 50 for update skip locked) returning *
$$;
create function public.wc_setup(p_key text,p_id text,p_username text,p_password text) returns boolean language plpgsql set search_path='' as $$
declare v jsonb; begin
 select value into v from public.wc_settings where key='setup' for update;
 if v is null or v->>'hash'<>p_key or (v->>'expires')::bigint<public.wc_now() or exists(select 1 from public.wc_users where role='admin') then return false; end if;
 insert into public.wc_users(id,username,name,role,password) values(p_id,p_username,'Administrator','admin',p_password);
 delete from public.wc_settings where key='setup'; return true;
end $$;
create function public.wc_room_delete(p_token text,p_room text) returns void language plpgsql set search_path='' as $$
begin
 if not exists(select 1 from public.wc_sessions s join public.wc_users u on u.id=s.user_id where s.token_hash=p_token and u.role='admin' and not u.disabled) then raise exception '403|Admin required.'; end if;
 perform 1 from public.wc_rooms where id=p_room for update;
 insert into public.wc_deletions select id from public.wc_attachments where room_id=p_room on conflict do nothing;
 delete from public.wc_rooms where id=p_room;
 perform public.wc_signal(null);
end $$;
-- Defense in depth: no direct client access to any chat table or privileged RPC.
do $$ declare r record; begin
 for r in select tablename from pg_tables where schemaname='public' and tablename like 'wc\_%' escape '\' loop
 execute format('alter table public.%I enable row level security',r.tablename);
 execute format('revoke all on public.%I from anon, authenticated',r.tablename);
 execute format('grant all on public.%I to service_role',r.tablename);
 end loop;
 for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'wc\_%' escape '\' loop
 execute format('revoke all on function %s from public,anon,authenticated',r.signature);
 execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
grant usage,select on sequence public.wc_messages_seq_seq to service_role;
insert into storage.buckets(id,name,public,file_size_limit) values('wingchat-media','wingchat-media',false,26214400);
create function public.wc_reserve_upload(p_row jsonb) returns void language plpgsql set search_path='' as $$
declare used bigint; begin
 perform pg_advisory_xact_lock(78261440);
 -- Account for other app buckets and reservations not yet present in Storage.
 select coalesce(sum((metadata->>'size')::bigint),0) into used from storage.objects;
 select used+coalesce(sum(f.size),0) into used from public.wc_attachments f where not f.expired and not exists(select 1 from storage.objects o where o.bucket_id='wingchat-media' and o.name=f.id);
 if used+(p_row->>'size')::bigint>943718400 then raise exception '413|Free file storage is nearly full. Delete some attachments or wait for seven-day cleanup.'; end if;
 insert into public.wc_attachments(id,room_id,session_hash,filename,mime,size,created_at,expires_at)
 values(p_row->>'id',p_row->>'room_id',p_row->>'session_hash',p_row->>'filename',p_row->>'mime',(p_row->>'size')::bigint,(p_row->>'created_at')::bigint,(p_row->>'expires_at')::bigint);
end $$;
revoke all on function public.wc_reserve_upload(jsonb) from public,anon,authenticated;
grant execute on function public.wc_reserve_upload(jsonb) to service_role;
