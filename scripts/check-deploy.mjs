import { readFileSync } from 'node:fs';
const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const base = config.match(/^BASE_URL\s*=\s*"([^"]+)"/m)?.[1];
const kv = config.match(/\[\[kv_namespaces\]\]([\s\S]*?)(?=\n\[|$)/)?.[1];
if (!base || !/^https:\/\//.test(base) || !kv || !/^id\s*=\s*"[a-f0-9]{32}"/m.test(kv)) {
  console.error('Set a public HTTPS BASE_URL and the VON_KV namespace id in wrangler.toml before deploying. See README.md.');
  process.exit(1);
}
