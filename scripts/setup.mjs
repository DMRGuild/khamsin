import { copyFileSync, existsSync, writeFileSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
for (const name of ['admins', 'allowlist', 'tags']) {
  const path = `data/${name}.txt`;
  if (!existsSync(path)) copyFileSync(`${path}.example`, path, constants.COPYFILE_EXCL);
}
if (!existsSync('.dev.vars')) {
  writeFileSync('.dev.vars', `BASE_URL=http://localhost:8787\nCOOKIE_SECRET=${randomBytes(32).toString('base64')}\n`, { flag: 'wx', mode: 0o600 });
}
console.log('Local configuration ready. Add your npub to data/admins.txt AND data/allowlist.txt, then npm run seed:local and npm run dev. Existing configuration was preserved.');
