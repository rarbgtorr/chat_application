import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
await rm('dist', { recursive: true, force: true }); await mkdir('dist');
await cp('public', 'dist', { recursive: true, filter: path => !path.endsWith('realtime-source.js') });
await build({ entryPoints: ['public/realtime-source.js'], outfile: 'dist/realtime.js', bundle: true, format: 'esm', platform: 'browser', minify: true, target: ['es2022'] });
console.log('Static website built in dist/.');
