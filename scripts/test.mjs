import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import './build-templates.mjs';
await build({entryPoints:['tests/storage.test.ts','tests/d1.test.ts','tests/cli.test.ts','tests/wrangler-setup.test.ts'],outdir:'dist',outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'text'}});
await build({entryPoints:['scripts/config-cli.ts'],outfile:'dist/config-cli.mjs',bundle:true,platform:'node',format:'esm',packages:'external'});
for (const file of ['dist/storage.test.mjs','dist/d1.test.mjs','dist/cli.test.mjs','dist/wrangler-setup.test.mjs']) {
  const result=spawnSync(process.execPath,[file],{stdio:'inherit'});
  if (result.status !== 0) { process.exitCode=result.status ?? 1; break; }
}
