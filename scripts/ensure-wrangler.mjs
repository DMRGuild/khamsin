import { existsSync, copyFileSync, constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
const config = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
if (!existsSync(config)) {
  if (!process.argv.includes('--example')) {
    console.error('No personal wrangler.toml found. Run npm run setup first.');
    process.exitCode = 1;
  } else {
    copyFileSync(new URL('../wrangler.toml.example', import.meta.url), config, constants.COPYFILE_EXCL);
    console.log('Created ignored wrangler.toml from the example for a local build. Run npm run setup before using the app.');
  }
}
