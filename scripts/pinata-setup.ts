import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { Ask } from './wrangler-setup.ts';

export function pinataGuide(log: (message:string)=>void = console.log) {
  log('IPFS uploads via Pinata are recommended for Khamsin.');
  log('  1. Sign up / sign in at https://app.pinata.cloud/');
  log('  2. Open https://app.pinata.cloud/keys (API Keys) → New Key. Name the key and allow public file uploads and deletion.');
  log('  3. Create the key and copy its JWT into PINATA_JWT (not the API Key or API Secret).');
  log('  Guide: https://docs.pinata.cloud/quickstart');
}

export async function selectPinata(current:string|undefined, supplied:string|undefined, ask?:Ask, log=console.log) {
  pinataGuide(log);
  const validate=(value:string)=>{if (!['0','1'].includes(value)) throw new Error('Enter 1 or 0.');};
  const value=supplied ?? (ask ? await ask('Enable IPFS uploads via Pinata? (1 recommended / 0 skip)',current ?? '1',validate) : current ?? '1');
  validate(value);
  return value;
}

export async function configureLocalPinata(file:string, options:{enabled?:string; supplied?:string; reconfigure?:boolean; token?:string; ask?:Ask; secret?:()=>Promise<string>}) {
  const original=existsSync(file)?readFileSync(file,'utf8'):'';
  const vars=parseEnv(original);
  const enabled=options.enabled ?? (options.reconfigure || !original
    ? await selectPinata(vars.ENABLE_PINATA,options.supplied,options.ask)
    : options.supplied ?? vars.ENABLE_PINATA ?? '0');
  if (!['0','1'].includes(enabled)) throw new Error('ENABLE_PINATA must be 1 or 0.');
  let token=vars.PINATA_JWT || options.token?.trim();
  if (enabled==='1' && !token) {
    pinataGuide();
    if (!options.secret) throw new Error('Pinata is enabled but PINATA_JWT is missing. Supply the environment variable, run setup interactively, or use --set ENABLE_PINATA=0 to skip.');
    token=(await options.secret()).trim();
    if (!token) throw new Error('PINATA_JWT is required when IPFS uploads are enabled.');
  }
  let text=original;
  // Replace only this setting; keep unrelated values and comments intact.
  if (vars.ENABLE_PINATA!==enabled) {
    text=text.replace(/^(?:export\s+)?ENABLE_PINATA\s*=.*(?:\r?\n|$)/gm,'');
    text+=`${text && !text.endsWith('\n')?'\n':''}ENABLE_PINATA=${enabled}\n`;
  }
  if (enabled==='1' && !vars.PINATA_JWT && token) {
    if (/[\r\n"\\]/.test(token)) throw new Error('Enter a single JWT token.');
    text+=`${text && !text.endsWith('\n')?'\n':''}PINATA_JWT="${token}"\n`;
  }
  if (text!==original) {
    if (existsSync(file)) chmodSync(file,0o600);
    writeFileSync(file,text,{mode:0o600});
  }
}
