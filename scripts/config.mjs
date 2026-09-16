import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..',import.meta.url)));
await build({entryPoints:['scripts/config-cli.ts'],outfile:'dist/config-cli.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
const result=spawnSync(process.execPath,['--env-file-if-exists=.env','dist/config-cli.mjs',...process.argv.slice(2)],{stdio:'inherit'});
if(result.error) throw result.error;
process.exitCode=result.status ?? 1;
