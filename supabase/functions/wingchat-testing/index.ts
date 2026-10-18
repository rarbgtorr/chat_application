import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import webpush from 'npm:web-push@3.6.7';
import { createHandler } from '../wingchat/core.js';
const url=Deno.env.get('SUPABASE_URL')!;
const secrets=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}');
const db=createClient(url,secrets.default||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
Deno.serve(createHandler({db,webpush,supabaseUrl:url,prefix:'wct_',bucket:'wingchat-testing-media',functionName:'wingchat-testing',cookieName:'wf_testing_session',waitUntil:(promise:Promise<unknown>)=>EdgeRuntime.waitUntil(promise.catch(()=>console.error('Testing worker will retry.')))}));
