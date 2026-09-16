import { readFileSync } from 'node:fs';
const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const base = config.match(/^\s*BASE_URL\s*=\s*"([^"]+)"/m)?.[1];
function table(name) {
  const lines = config.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === `[[${name}]]`);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !lines[end].trim().startsWith('[')) end++;
  return lines.slice(start + 1, end).join('\n');
}
const kv = table('kv_namespaces');
const d1 = table('d1_databases');
const hasD1 = d1 && /^\s*database_id\s*=\s*"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}"/m.test(d1)
  && !d1.includes('00000000-0000-0000-0000-000000000000');
const hasKv = kv && /^\s*id\s*=\s*"[a-f0-9]{32}"/m.test(kv);
if (!base || !/^https:\/\//.test(base) || (d1 !== undefined ? !hasD1 || (kv !== undefined && !hasKv) : !hasKv)) {
  console.error('Set a public HTTPS BASE_URL and a valid DB database_id (or legacy VON_KV namespace id) in wrangler.toml before deploying. Remove an unused VON_KV block for D1-only deployments. See README.md.');
  process.exit(1);
}
