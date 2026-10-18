import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import webpush from 'npm:web-push@3.6.7';
import { createHandler } from './core.js';
const url=Deno.env.get('SUPABASE_URL')!;
const secrets=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}');
const key=secrets.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve(createHandler({db,webpush,supabaseUrl:url,waitUntil:(promise:Promise<unknown>)=>EdgeRuntime.waitUntil(promise.catch(()=>console.error('Chat worker will retry.')))}));
