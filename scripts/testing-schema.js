// Render a separate Testing backend without copying production accounts or messages.
// Apply the output once to the shared Free project using the Supabase migration tool.
import {readFile} from 'node:fs/promises';
for(const file of ['20261018094257_wingchat_hosted_backend.sql','20261018094959_wingchat_explicit_deny_policies.sql','20261018110921_voice_calls.sql','20261018123000_video_calls.sql']){
  const sql=await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
  process.stdout.write(sql.replaceAll('wc_','wct_').replaceAll('wc\\_','wct\\_').replaceAll('wingchat-media','wingchat-testing-media')+'\n');
}
