do $$ declare r record; begin
 for r in select tablename from pg_tables where schemaname='public' and tablename like 'wc\_%' escape '\' loop
 execute format('create policy wc_server_only on public.%I for all to anon,authenticated using(false) with check(false)',r.tablename);
 end loop;
end $$;
