import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
await rm('dist', { recursive: true, force: true }); await mkdir('dist');
await cp('public', 'dist', { recursive: true, filter: path => !path.endsWith('realtime-source.js') });

const isPreview = process.env.BRANCH === 'Testing' || ['branch-deploy', 'deploy-preview'].includes(process.env.CONTEXT);
const functionName = isPreview ? 'wingchat-testing' : 'wingchat';
await writeFile(
  'dist/_redirects',
  `/api/*  https://nmgjkexfgytjivxudsmo.supabase.co/functions/v1/${functionName}/:splat  200!\n/*        /index.html  200\n`,
);

await build({ entryPoints: ['public/realtime-source.js'], outfile: 'dist/realtime.js', bundle: true, format: 'esm', platform: 'browser', minify: true, target: ['es2022'] });
console.log(`Static website built in dist/ with the ${isPreview ? 'testing' : 'production'} backend.`);
