import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { Writable } from 'node:stream';
import { configureLocalPinata } from './pinata-setup.ts';
import { openSqlite } from '../src/storage/sqlite.ts';
import { normalizeIdentity } from '../src/storage/identity.ts';
import { CUSTOM_SLOTS, type SqlDriver, type Statement } from '../src/storage/types.ts';
import { legacyRecords, planMerge, importStatement, bootstrapStatement, type Snapshot } from '../src/storage/transfer.ts';
import { configureWrangler, ensureRemoteSecrets, type Ask, type RunOptions, type WranglerConfig } from './wrangler-setup.ts';

const {values,positionals} = parseArgs({allowPositionals:true,options:{
  target:{type:'string'}, admin:{type:'string'}, from:{type:'string'}, 'from-kv':{type:'boolean'},
  name:{type:'string'}, 'base-url':{type:'string'}, 'database-name':{type:'string'}, 'database-id':{type:'string'},
  'account-id':{type:'string'}, reconfigure:{type:'boolean'}, advanced:{type:'boolean'}, defaults:{type:'boolean'},
  'configure-only':{type:'boolean'}, set:{type:'string',multiple:true},
  apply:{type:'boolean'}, 'overwrite-html':{type:'boolean'}, output:{type:'string'}, help:{type:'boolean'},
}});
const command = positionals[0];
if (values.help || !command) {
  console.log(`Khamsin configuration\n\n  npm run setup -- [--target local|sqlite|remote] [--admin npub1…] [--reconfigure] [--advanced]\n  npm run setup -- --target local --configure-only --defaults\n  IPFS is recommended and enabled for new setups. Supply PINATA_JWT or enter it when prompted.\n  Skip IPFS with --set ENABLE_PINATA=0.\n  Setup flags: --name, --base-url, --database-name, --database-id, --account-id, --set KEY=VALUE\n  npm run config:import -- --target local|sqlite|remote --from ./data [--apply]\n  npm run config:import -- --target local|sqlite|remote --from-kv [--apply]\n  npm run config:export -- --target local|sqlite|remote --output backup.json\n\nImports merge lists and preserve existing HTML/pins. --overwrite-html replaces matching HTML.\n--from accepts a data directory or a JSON export. --from-kv reads the same local/remote KV;\nwith target sqlite, it reads local KV. Imports preview by default. No setup files are required.`);
  process.exit(0);
}
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const bold = (s:string) => color ? `\x1b[1;36m${s}\x1b[0m` : s;
let hideInput=false;
const promptOutput=new Writable({write(chunk,_encoding,callback) {
  if (!hideInput) process.stdout.write(chunk);
  callback();
}});
const rl = process.stdin.isTTY && !values.defaults ? createInterface({input:process.stdin,output:promptOutput,terminal:true}) : null;
const ask: Ask | undefined = rl ? async (label, fallback, validate) => {
  while (true) {
    const answer = (await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
    try { validate?.(answer); return answer; }
    catch (err) { console.log((err as Error).message); }
  }
} : undefined;
async function askPinataSecret():Promise<string> {
  while (true) {
    process.stdout.write('Pinata JWT (hidden input): ');
    hideInput=true;
    let value:string;
    try {value=(await rl!.question('')).trim();}
    finally {hideInput=false; process.stdout.write('\n');}
    if (value) return value;
    console.log('A JWT is required. To skip IPFS, rerun with --set ENABLE_PINATA=0.');
  }
}
function wrangler(args: string[], capture = true, options: RunOptions = {}): string {
  if (options.interactive) rl?.pause();
  const result = spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{
    encoding:'utf8', input:options.input,
    stdio:options.interactive ? 'inherit' : capture ? [options.input===undefined?'ignore':'pipe','pipe','pipe'] : ['ignore','inherit','inherit'],
    maxBuffer:64*1024*1024,
    env:{...process.env,...options.env,WRANGLER_SEND_METRICS:'false'},
  });
  if (options.interactive) rl?.resume();
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(capture ? result.stderr || result.stdout || 'Wrangler failed' : 'Wrangler failed');
  return result.stdout || '';
}
function sqlText(statement: Statement): string {
  let i=0;
  return statement.sql.replace(/\?/g,()=>{
    const value = statement.params?.[i++];
    if (value === null) return 'NULL';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return `'${value.replaceAll("'","''")}'`;
    throw new Error('Missing SQL parameter');
  });
}
function d1Driver(target: string): SqlDriver {
  async function execute(statement: Statement) {
    const dir=mkdtempSync(join(tmpdir(),'khamsin-'));
    try {
      const sql=sqlText(statement);
      const file=join(dir,'query.sql');
      // Remote --file imports SQL and returns statistics, not SELECT/RETURNING rows.
      // Keep local file execution so large local imports do not use argv.
      if (target!=='remote') writeFileSync(file,sql,{mode:0o600});
      const input=target==='remote' ? ['--command',sql] : ['--file',file];
      const output=JSON.parse(wrangler(['d1','execute','DB',`--${target}`,...input,'--json']));
      if (!Array.isArray(output) || output.some(r=>r.success === false)) throw new Error('D1 query failed');
      return output.flatMap(r=>r.results || []);
    } finally { rmSync(dir,{recursive:true,force:true}); }
  }
  return {all:execute, async run(s) { await execute(s); }};
}
async function snapshot(db:SqlDriver):Promise<Snapshot> {
  const [row] = await db.all<{version:number;data:string}>({sql:`SELECT version,
    (SELECT json_group_array(json_object('collection',collection,'key',key,'value',value)) FROM records) AS data
    FROM store_revision WHERE id=1`});
  return {version:row.version,records:JSON.parse(row.data)};
}
async function readLegacyKv(target:string):Promise<Record<string,string>> {
  console.log('Reading current KV (pause administrative edits while migrating)…');
  const where=target==='remote' ? '--remote' : '--local';
  const keys=JSON.parse(wrangler(['kv','key','list','--binding','VON_KV',where]));
  const data:Record<string,string>={};
  for (const item of keys) if (['admins','allowlist','tags'].includes(item.name) || item.name.startsWith('custom:') || item.name.startsWith('pin:')) {
    data[item.name]=wrangler(['kv','key','get','--binding','VON_KV',where,item.name,'--text']);
  }
  return data;
}
let close = () => {};
async function main() {
  console.log('\n'+bold('  KHAMSIN  /  '+(command==='setup' ? 'First-time setup' : command))+'\n');
  let target=values.target;
  if (!target && command==='setup' && rl) {
    console.log('  1  Cloudflare Workers — local development\n  2  Linux / Node.js — SQLite\n  3  Cloudflare Workers — production D1\n');
    const answer=(await rl.question('Choose environment [1]: ')).trim() || '1';
    target=({'1':'local','2':'sqlite','3':'remote'} as Record<string,string>)[answer];
  }
  if (!target || !['local','sqlite','remote'].includes(target)) throw new Error('Specify --target local, sqlite, or remote.');
  console.log(`Target: ${target}${target==='sqlite' ? ' ('+(process.env.DATABASE_PATH || '.state/khamsin.sqlite')+')' : ''}`);
  let setupConfig: WranglerConfig | undefined;
  const run = (args:string[], options?:RunOptions) => wrangler(args,!options?.interactive,options);
  if (command==='setup' && target!=='sqlite') {
    setupConfig=await configureWrangler({target:target as 'local'|'remote',options:values,ask,run});
    if (setupConfig.account_id) process.env.CLOUDFLARE_ACCOUNT_ID=setupConfig.account_id;
    if (values['configure-only']) {
      console.log('Configuration saved. No login, remote resources, database migrations, or administrator changes were performed.');
      return;
    }
  } else if (values['configure-only']) throw new Error('--configure-only is for local/remote Wrangler configuration.');
  let db:SqlDriver;
  if (target==='sqlite') {
    const path=resolve(process.env.DATABASE_PATH || '.state/khamsin.sqlite');
    if (command!=='setup' && !existsSync(path)) throw new Error('Run setup for this target first.');
    const opened=openSqlite(path); db=opened.store.db; close=()=>opened.database.close();
    if (command==='setup') opened.database.exec(readFileSync('migrations/0001_store.sql','utf8'));
  } else {
    if (!existsSync('wrangler.toml')) throw new Error('Missing wrangler.toml. Run npm run setup first.');
    if (command==='setup') wrangler(['d1','migrations','apply','DB',`--${target}`],false);
    db=d1Driver(target);
  }
  if (command==='setup') {
    const current=await snapshot(db);
    if (current.records.some(r=>r.collection==='admins' || (r.collection==='meta' && r.key==='initialized'))) {
      console.log('\n✓ Already initialized. Administrator and existing data preserved.');
    } else {
      console.log('\n'+bold('Step 1 · Register your administrator'));
      console.log('Paste your PUBLIC Nostr key (npub or hex). Never enter your private nsec key.');
      let key:string|undefined=values.admin;
      while (true) {
        if (!key && rl) key=await rl.question('Administrator public key: ');
        if (!key) throw new Error('Provide --admin <npub-or-hex> when running without a terminal.');
        try { key=normalizeIdentity(key,true); break; } catch(err) {
          if (values.admin || !rl) throw err;
          console.log((err as Error).message); key=undefined;
        }
      }
      const inserted=await db.all(bootstrapStatement(key));
      if (!inserted.length) throw new Error('This database was initialized by another process; no changes applied.');
      console.log('✓ Administrator and access permission registered together.');
    }
    if (target==='remote' && setupConfig) ensureRemoteSecrets(setupConfig,run,console.log,{interactive:Boolean(rl),pinataToken:process.env.PINATA_JWT});
    if (target!=='remote') {
      const file=target==='sqlite' ? '.env' : '.dev.vars';
      const fresh=!existsSync(file);
      await configureLocalPinata(file,{enabled:setupConfig?.vars.ENABLE_PINATA,
        supplied:values.set?.filter(value=>value.startsWith('ENABLE_PINATA=')).at(-1)?.slice('ENABLE_PINATA='.length),
        reconfigure:values.reconfigure || fresh,token:process.env.PINATA_JWT,ask,secret:rl?askPinataSecret:undefined});
      if (fresh) writeFileSync(file,`BASE_URL=http://localhost:8787\nCOOKIE_SECRET=${randomBytes(32).toString('base64')}\n${target==='sqlite'?'SKIN=blackboard\nFORCE_ALLOW_TAGLESS=1\nDISABLE_ZAPS=1\n':''}${readFileSync(file,'utf8')}`,{mode:0o600});
      console.log(`✓ ${file} ready (existing secrets preserved).`);
    }
    console.log('\n'+bold('Ready'));
    console.log(target==='sqlite' ? '  npm run build:node\n  npm start' : target==='local' ? '  npm run dev' : '  npm run deploy');
    console.log('  Sign in with your Nostr extension, then open /admin.\n  No data/ files or seed command are needed.\n');
  } else if (command==='export') {
    if (!values.output) throw new Error('Specify --output <file.json>.');
    const current=await snapshot(db); const legacy:Record<string,string>={};
    for (const row of current.records) {
      if (['admins','allowlist','tags'].includes(row.collection)) legacy[row.collection]=(legacy[row.collection] || '')+row.key+'\n';
      if (row.collection==='custom') legacy[`custom:${row.key}`]=row.value;
      if (row.collection==='pins') legacy[`pin:${row.key}`]=row.value;
    }
    writeFileSync(values.output,JSON.stringify(legacy,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(`Exported to ${values.output}`);
  } else if (command==='import') {
    if (Boolean(values.from)===Boolean(values['from-kv'])) throw new Error('Choose exactly one of --from <directory-or-json> or --from-kv.');
    let legacy:Record<string,string>={};
    if (values['from-kv']) legacy=await readLegacyKv(target);
    else if (values.from!.endsWith('.json')) legacy=JSON.parse(readFileSync(values.from!,'utf8'));
    else {
      if (!existsSync(values.from!) || !statSync(values.from!).isDirectory()) throw new Error('Import source must be an existing directory or JSON export.');
      for (const name of ['admins','allowlist','tags']) {
        const file=join(values.from!,`${name}.txt`); if (existsSync(file)) legacy[name]=readFileSync(file,'utf8');
      }
      for (const slot of CUSTOM_SLOTS) {
        const file=join(values.from!,'custom',`${slot}.html`); if (existsSync(file)) legacy[`custom:${slot}`]=readFileSync(file,'utf8');
      }
    }
    if (!legacy || Array.isArray(legacy) || Object.values(legacy).some(v=>typeof v!=='string')) throw new Error('Expected a JSON object mapping legacy keys to text values.');
    const current=await snapshot(db);
    const rows=planMerge(current.records,legacyRecords(legacy,process.env.LEXICON_COLLECTION),values['overwrite-html']);
    for (const row of rows) console.log(`  ${row.collection === 'custom' && current.records.some(r=>r.collection===row.collection && r.key===row.key) ? 'UPDATE' : 'ADD'} ${row.collection}: ${row.key}`);
    console.log(`\n${rows.length} changes. Missing files, existing lists and pin ownership are preserved.`);
    if (!values.apply) console.log('Preview only. Repeat with --apply to import; --overwrite-html explicitly replaces HTML.');
    else if (rows.length) {
      const result=await db.all(importStatement(rows,current.version));
      if (result.length!==rows.length) throw new Error('Data changed during preview. Import not applied; run again.');
      console.log('✓ Imported atomically.');
    }
  } else throw new Error('Unknown command. Use --help.');
}
try { await main(); }
catch (err) { console.error('\n'+(err as Error).message); process.exitCode=1; }
finally { rl?.close(); close(); }
