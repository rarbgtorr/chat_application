// Render a separate Testing backend without copying production accounts or messages.
// Apply the output once to the shared Free project using the Supabase migration tool.
import {readFile,readdir} from 'node:fs/promises';
for(const file of (await readdir(new URL('../supabase/migrations/',import.meta.url))).filter(file=>file.endsWith('.sql')).sort()){
  const sql=await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
  process.stdout.write(sql.replaceAll('wc_','wct_').replaceAll('wc\\_','wct\\_').replaceAll('wingchat-media','wingchat-testing-media')+'\n');
}
