import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
if (!existsSync(new URL('../wrangler.toml', import.meta.url))) {
  console.error('No personal wrangler.toml found. Run npm run setup -- --target remote.');
  process.exit(1);
}
let config;
try {
  config = parse(readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8'));
} catch (err) {
  console.error(`Invalid wrangler.toml: ${err.message}`);
  process.exit(1);
}
const base = config.vars?.BASE_URL;
const kv = Array.isArray(config.kv_namespaces) ? config.kv_namespaces.find(row => row.binding === 'VON_KV') : undefined;
const d1 = Array.isArray(config.d1_databases) ? config.d1_databases.find(row => row.binding === 'DB') : undefined;
const hasD1 = d1 && typeof d1.database_id === 'string'
  && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(d1.database_id)
  && d1.database_id !== '00000000-0000-0000-0000-000000000000';
const hasKv = kv && typeof kv.id === 'string' && /^[a-f0-9]{32}$/i.test(kv.id);
if (!base || !/^https:\/\//.test(base) || (d1 !== undefined ? !hasD1 || (kv !== undefined && !hasKv) : !hasKv)) {
  console.error('Set a public HTTPS BASE_URL and a valid DB database_id (or legacy VON_KV namespace id) in wrangler.toml before deploying. Remove an unused VON_KV block for D1-only deployments. See README.md.');
  process.exit(1);
}
