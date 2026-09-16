import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'smol-toml';
import { configureWrangler, ensureRemoteSecrets, LOCAL_DATABASE_ID, type Ask, type Run, type WranglerConfig } from '../scripts/wrangler-setup.ts';

const account='a'.repeat(32), database='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function fixture() {
  const cwd=mkdtempSync(join(tmpdir(),'khamsin-wizard-'));
  copyFileSync('wrangler.toml.example',join(cwd,'wrangler.toml.example'));
  return {cwd, path:join(cwd,'wrangler.toml'), close:()=>rmSync(cwd,{recursive:true,force:true})};
}
const noNetwork:Run=()=>{throw new Error('Unexpected network operation');};
const quiet=()=>{};

test('fresh local configuration is generated offline with all variables and no legacy KV',async()=>{
  const f=fixture();
  try {
    const config=await configureWrangler({cwd:f.cwd,target:'local',options:{name:'my-archive',set:['SITE_NAME=My "Archive"','DISABLE_ZAPS=0']},run:noNetwork,log:quiet});
    assert.equal(config.name,'my-archive');
    assert.equal(config.vars.SITE_NAME,'My "Archive"');
    assert.equal(config.vars.DISABLE_ZAPS,'0');
    assert.equal(config.d1_databases[0].database_id,LOCAL_DATABASE_ID);
    assert.equal(config.d1_databases[0].database_name,'my-archive');
    assert.equal(config.kv_namespaces,undefined);
    assert.equal(config.vars.COOKIE_SECRET,undefined);
    assert.deepEqual(parse(readFileSync(f.path,'utf8')),config);
    const before=readFileSync(f.path,'utf8');
    await configureWrangler({cwd:f.cwd,target:'local',options:{},run:noNetwork,ask:()=>{throw new Error('Existing configuration prompted unexpectedly');},log:quiet});
    assert.equal(readFileSync(f.path,'utf8'),before);
  } finally {f.close();}
});

test('advanced wizard covers all public vars, preserves unrelated options, and backs up edits',async()=>{
  const f=fixture();
  try {
    const initial=parse(readFileSync(join(f.cwd,'wrangler.toml.example'),'utf8')) as WranglerConfig;
    initial.observability={enabled:true}; initial.kv_namespaces=[{binding:'VON_KV',id:'c'.repeat(32)}];
    initial.r2_buckets=[{binding:'OTHER_BUCKET',bucket_name:'keep-me'}];
    writeFileSync(f.path,stringify(initial)); const before=readFileSync(f.path,'utf8');
    const prompts:string[]=[];
    const ask:Ask=async(label,fallback,validate)=>{
      prompts.push(label);
      const answer=label.startsWith('Site name')?'Changed site':label.startsWith('Existing R2')?'archive-wasm':fallback;
      validate?.(answer); return answer;
    };
    const config=await configureWrangler({cwd:f.cwd,target:'local',options:{reconfigure:true,advanced:true},ask,run:noNetwork,log:quiet});
    assert.ok(prompts.some(p=>p.startsWith('Nostr relays')));
    assert.ok(prompts.some(p=>p.startsWith('Maximum upload')));
    assert.deepEqual(config.observability,{enabled:true});
    assert.equal(config.kv_namespaces[0].id,'c'.repeat(32));
    assert.equal(config.r2_buckets.length,2);
    assert.equal(config.vars.SITE_NAME,'Changed site');
    const backups=readdirSync(join(f.cwd,'backups'));
    assert.equal(backups.length,1);
    assert.equal(readFileSync(join(f.cwd,'backups',backups[0]),'utf8'),before);
  } finally {f.close();}
});

test('remote setup creates/reuses D1 and preserves local state when promoting a binding',async()=>{
  const f=fixture();
  try {
    await configureWrangler({cwd:f.cwd,target:'local',options:{},run:noNetwork,log:quiet});
    let created=false; let creates=0;
    const run:Run=(args,opts)=>{
      if(args[0]==='whoami') return JSON.stringify({accounts:[{id:account,name:'Account'}]});
      assert.equal(opts?.env?.CLOUDFLARE_ACCOUNT_ID,account);
      if(args[1]==='list') return JSON.stringify(created?[{name:'khamsin',uuid:database}]:[]);
      assert.deepEqual(args.slice(0,4),['d1','create','khamsin','--update-config=false']);
      assert.equal((parse(readFileSync(args[args.length-1],'utf8')) as WranglerConfig).account_id,account); creates++; created=true; return '';
    };
    const config=await configureWrangler({cwd:f.cwd,target:'remote',options:{'base-url':'https://archive.example'},run,log:quiet});
    assert.equal(config.account_id,account);
    assert.equal(config.d1_databases[0].database_id,database);
    assert.equal(config.d1_databases[0].preview_database_id,LOCAL_DATABASE_ID);
    await configureWrangler({cwd:f.cwd,target:'remote',options:{},run,log:quiet});
    assert.equal(creates,1);
  } finally {f.close();}
});

test('invalid input and unknown remote IDs never silently replace existing databases',async()=>{
  const f=fixture();
  try {
    await assert.rejects(configureWrangler({cwd:f.cwd,target:'remote',options:{'base-url':'http://localhost:8787'},run:noNetwork,log:quiet}),/https/);
    await assert.rejects(configureWrangler({cwd:f.cwd,target:'local',options:{set:['COOKIE_SECRET=do-not-store']},run:noNetwork,log:quiet}),/Unknown public setting/);
    assert.equal(existsSync(f.path),false);
    const run:Run=args=>args[0]==='whoami'?JSON.stringify({accounts:[{id:account,name:'A'}]}):'[]';
    await assert.rejects(configureWrangler({cwd:f.cwd,target:'remote',options:{'base-url':'https://archive.example','database-id':database},run,log:quiet}),/not in the selected account/);
    assert.equal(existsSync(f.path),false);
  } finally {f.close();}
});

test('configure-only remote requires a real ID and never logs in or provisions',async()=>{
  const f=fixture();
  try {
    const options={'configure-only':true,'base-url':'https://archive.example'};
    await assert.rejects(configureWrangler({cwd:f.cwd,target:'remote',options,run:noNetwork,log:quiet}),/requires --database-id/);
    await configureWrangler({cwd:f.cwd,target:'remote',options:{...options,'database-id':database},run:noNetwork,log:quiet});
    assert.equal((parse(readFileSync(f.path,'utf8')) as WranglerConfig).d1_databases[0].database_id,database);
  } finally {f.close();}
});

test('remote cookie secret is generated via stdin once; permission failures never rotate it',()=>{
  const config={account_id:account,vars:{ENABLE_PINATA:'0'}};
  let exists=false; let puts=0;
  const logs:string[]=[];
  const run:Run=(args,opts)=>{
    if(args[1]==='list') return JSON.stringify(exists?[{name:'COOKIE_SECRET'}]:[]);
    assert.deepEqual(args,['secret','put','COOKIE_SECRET']);
    assert.ok((opts?.input?.length || 0)>=32); puts++; exists=true; return '';
  };
  ensureRemoteSecrets(config,run,message=>logs.push(message));
  ensureRemoteSecrets(config,run,message=>logs.push(message));
  assert.equal(puts,1);
  assert.throws(()=>ensureRemoteSecrets(config,()=>{throw new Error('permission denied');}),/permission denied/);
});

test('Pinata setup uses hidden input or stdin and preserves existing tokens',()=>{
  const secrets=[{name:'COOKIE_SECRET'}];
  let puts=0;
  const run:Run=(args,options)=>{
    if(args[1]==='list') return JSON.stringify(secrets);
    assert.deepEqual(args,['secret','put','PINATA_JWT']);
    assert.equal(options?.input,'test-token'); puts++;
    secrets.push({name:'PINATA_JWT'}); return '';
  };
  const config={vars:{ENABLE_PINATA:'1'}};
  ensureRemoteSecrets(config,run,quiet,{pinataToken:'test-token'});
  ensureRemoteSecrets(config,run,quiet,{pinataToken:'replacement-must-not-be-used'});
  assert.equal(puts,1);
  assert.throws(()=>ensureRemoteSecrets(config,()=>JSON.stringify([{name:'COOKIE_SECRET'}]),quiet),/PINATA_JWT is missing/);
});
