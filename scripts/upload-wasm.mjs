import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const [mode, bucket, ...extra] = process.argv.slice(2);
if (!['--local', '--remote'].includes(mode) || !bucket || extra.length || !/^[a-z0-9][a-z0-9-]*$/.test(bucket)) {
  console.error('Usage: npm run upload:wasm -- --local|--remote BUCKET_NAME');
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'khamsin-wasm-'));
try {
  const path = join(dir, 'pandoc.wasm');
  writeFileSync(path, gunzipSync(readFileSync('public/gentou/pandoc.wasm.gz')));
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'r2', 'object', 'put', `${bucket}/pandoc.wasm`, '--file', path, '--content-type', 'application/wasm', mode], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
