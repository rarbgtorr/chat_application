import { createClient } from '@supabase/supabase-js';
export function connect(config, onChange, onStatus, onTyping = () => {}) {
  const client = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const channel = client.channel(config.topic).on('broadcast', { event: 'change' }, onChange).on('broadcast', { event: 'typing' }, message => onTyping(message.payload)).subscribe(onStatus);
  return { close() { void client.removeChannel(channel); void client.realtime.disconnect(); } };
}
