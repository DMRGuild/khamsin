import { build } from 'esbuild';
import './build-templates.mjs';
await build({entryPoints:['src/node.ts'],outfile:'dist/node.mjs',bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'text'},sourcemap:true});
