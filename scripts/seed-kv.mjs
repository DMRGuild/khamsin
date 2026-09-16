import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 1 || !['--local', '--remote'].includes(args[0])) {
  console.error('Usage: node scripts/seed-kv.mjs --local|--remote (overwrites the listed KV keys)');
  process.exit(1);
}
const entries = ['allowlist', 'tags', 'admins'].map(key => [key, `data/${key}.txt`]);
for (const slot of ['index', 'about', 'main-header', 'main-footer', 'sidebar-header', 'sidebar-footer']) entries.push([`custom:${slot}`, `data/custom/${slot}.html`]);
for (const [key, path] of entries) {
  if (!existsSync(path)) { console.log(`Skipped ${key}: ${path} does not exist`); continue; }
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'kv', 'key', 'put', '--binding', 'VON_KV', args[0], key, '--path', path], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
