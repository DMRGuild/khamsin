import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'smol-toml';
import { configureWrangler, ensureRemoteSecrets, getWorkersSubdomain, LOCAL_DATABASE_ID, type Ask, type Run, type WranglerConfig } from '../scripts/wrangler-setup.ts';

const account='a'.repeat(32), database='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function fixture() {
  const cwd=mkdtempSync(join(tmpdir(),'khamsin-wizard-'));
  copyFileSync('wrangler.toml.example',join(cwd,'wrangler.toml.example'));
  return {cwd, path:join(cwd,'wrangler.toml'), close:()=>rmSync(cwd,{recursive:true,force:true})};
}
const noNetwork:Run=()=>{throw new Error('Unexpected network operation');};
const quiet=()=>{};
const noRequest:typeof fetch=async()=>{throw new Error('Unexpected HTTP request');};

test('remote login and account selection precede settings and supply the URL for the chosen Worker name',async()=>{
  const f=fixture();
  const selectedAccount='c'.repeat(32);
  const events:string[]=[];
  let loggedIn=false;
  try {
    const run:Run=(args,opts)=>{
      events.push(args.slice(0,2).join(' '));
      if(args[0]==='whoami') {
        if(!loggedIn) throw new Error('Not logged in');
        return JSON.stringify({accounts:[{id:account,name:'First account'},{id:selectedAccount,name:'Not the subdomain'}]});
      }
      if(args[0]==='login') {assert.equal(opts?.interactive,true); loggedIn=true; return '';}
      if(args[0]==='auth') return JSON.stringify({type:'oauth',token:'test-token'});
      assert.deepEqual(args.slice(0,3),['d1','list','--json']);
      assert.equal(opts?.env?.CLOUDFLARE_ACCOUNT_ID,selectedAccount);
      assert.equal((parse(readFileSync(args[args.length-1],'utf8')) as WranglerConfig).account_id,selectedAccount);
      return JSON.stringify([{name:'maelstrom',uuid:database}]);
    };
    const ask:Ask=async(label,fallback,validate)=>{
      events.push(label);
      const answer=label.startsWith('Cloudflare account')?'2':label==='Worker name'?'maelstrom':fallback;
      if(label.startsWith('Public URL')) assert.equal(fallback,'https://maelstrom.actual-subdomain.workers.dev');
      validate?.(answer); return answer;
    };
    const request:typeof fetch=async(url,init)=>{
      assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${selectedAccount}/workers/subdomain`);
      assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer test-token');
      events.push('subdomain');
      return Response.json({success:true,result:{subdomain:'actual-subdomain'}});
    };
    const config=await configureWrangler({cwd:f.cwd,target:'remote',options:{},run,ask,request,log:quiet});
    assert.equal(config.vars.BASE_URL,'https://maelstrom.actual-subdomain.workers.dev');
    assert.equal(config.account_id,selectedAccount);
    assert.deepEqual(events.slice(0,6),['whoami --json','Open Cloudflare browser login? (y / n)','login','whoami --json','Cloudflare account (number or account ID)','Worker name']);
    assert.ok(events.indexOf('subdomain')<events.findIndex(e=>e.startsWith('Public URL')));
    assert.ok(events.findIndex(e=>e.startsWith('Public URL'))<events.indexOf('d1 list'));
    assert.ok(!readFileSync(f.path,'utf8').includes('test-token'));
  } finally {f.close();}
});

test('subdomain discovery supports Wrangler OAuth, API tokens and API key credentials',async()=>{
  for (const auth of [{type:'oauth',token:'oauth-token'},{type:'api_token',token:'api-token'},{type:'api_key',key:'key',email:'user@example.com'}]) {
    const run:Run=args=>{assert.deepEqual(args,['auth','token','--json']); return JSON.stringify(auth);};
    const request:typeof fetch=async(_url,init)=>{
      const headers=new Headers(init?.headers);
      if(auth.type==='api_key') {
        assert.equal(headers.get('X-Auth-Key'),auth.key);
        assert.equal(headers.get('X-Auth-Email'),auth.email);
        assert.equal(headers.get('Authorization'),null);
      } else assert.equal(headers.get('Authorization'),`Bearer ${auth.token}`);
      assert.ok(init?.signal);
      assert.equal(init?.redirect,'error');
      return Response.json({success:true,result:{subdomain:'my-account'}});
    };
    assert.equal(await getWorkersSubdomain(account,run,request),'my-account');
  }
  await assert.rejects(getWorkersSubdomain(account,()=>{throw new Error('sensitive-token');},noRequest),{
    message:'Could not retrieve the account workers.dev subdomain.',
  });
});

test('missing or inaccessible subdomains allow manual URL input without exposing API errors',async()=>{
  for (const mode of ['missing','forbidden','network','malformed']) {
    const f=fixture();
    const logs:string[]=[];
    try {
      const run:Run=args=>args[0]==='whoami'?JSON.stringify({accounts:[{id:account,name:'A'}]}):
        args[0]==='auth'?JSON.stringify({type:'api_token',token:'sensitive-token'}):JSON.stringify([{name:'khamsin',uuid:database}]);
      const request:typeof fetch=async()=>{
        if(mode==='network') throw new Error('sensitive-token');
        if(mode==='forbidden') return Response.json({success:false,errors:[{message:'sensitive-token'}]},{status:403});
        return Response.json({success:true,result:{subdomain:mode==='missing'?'':'bad/subdomain'}});
      };
      const ask:Ask=async(label,fallback,validate)=>{
        const answer=label.startsWith('Public URL')?'https://archive.example':fallback;
        validate?.(answer); return answer;
      };
      const config=await configureWrangler({cwd:f.cwd,target:'remote',options:{},run,request,ask,log:message=>logs.push(message)});
      assert.equal(config.vars.BASE_URL,'https://archive.example');
      assert.ok(logs.some(message=>/subdomain/.test(message)));
      assert.ok(!logs.join('\n').includes('sensitive-token'));
    } finally {f.close();}
  }
});

test('remote URL defaults work unattended and follow renamed Workers while preserving custom or explicit origins',async()=>{
  const f=fixture();
  let lookups=0;
  const run:Run=args=>{
    if(args[0]==='whoami') return JSON.stringify({accounts:[{id:account,name:'A'}]});
    if(args[0]==='auth') return JSON.stringify({type:'oauth',token:'test-token'});
    return JSON.stringify([{name:'khamsin',uuid:database}]);
  };
  const request:typeof fetch=async()=>{lookups++; return Response.json({success:true,result:{subdomain:'my-account'}});};
  try {
    const setup=(options:Parameters<typeof configureWrangler>[0]['options'])=>configureWrangler({cwd:f.cwd,target:'remote',options,run,request,log:quiet});
    assert.equal((await setup({})).vars.BASE_URL,'https://khamsin.my-account.workers.dev');
    assert.equal((await setup({name:'maelstrom'})).vars.BASE_URL,'https://maelstrom.my-account.workers.dev');
    assert.equal(lookups,2);
    const before=readFileSync(f.path,'utf8');
    await assert.rejects(configureWrangler({cwd:f.cwd,target:'remote',options:{name:'renamed'},run,request:noRequest,log:quiet}),/Specify --base-url/);
    assert.equal(readFileSync(f.path,'utf8'),before);
    await setup({}); // A normal rerun keeps the configured URL without a lookup.
    assert.equal(lookups,2);
    assert.equal((await setup({'base-url':'https://archive.example'})).vars.BASE_URL,'https://archive.example');
    assert.equal((await setup({name:'another-worker'})).vars.BASE_URL,'https://archive.example');
    assert.equal(lookups,2);
  } finally {f.close();}
});

test('unattended setup without a discovered URL stops before provisioning or saving',async()=>{
  const f=fixture();
  try {
    const run:Run=args=>{
      if(args[0]==='whoami') return JSON.stringify({accounts:[{id:account,name:'A'}]});
      assert.equal(args[0],'auth');
      throw new Error('Credentials unavailable');
    };
    await assert.rejects(configureWrangler({cwd:f.cwd,target:'remote',options:{},run,request:noRequest,log:quiet}),/Specify --base-url/);
    assert.equal(existsSync(f.path),false);
  } finally {f.close();}
});

test('remote account selection does not guess when unattended or accept an unavailable account',async()=>{
  const f=fixture();
  try {
    const run:Run=args=>{
      assert.equal(args[0],'whoami');
      return JSON.stringify({accounts:[{id:account,name:'A'},{id:'c'.repeat(32),name:'B'}]});
    };
    await assert.rejects(configureWrangler({cwd:f.cwd,target:'remote',options:{},run,request:noRequest,log:quiet}),/Specify --account-id/);
    await assert.rejects(configureWrangler({cwd:f.cwd,target:'remote',options:{'account-id':'d'.repeat(32)},run,request:noRequest,log:quiet}),/not available/);
    assert.equal(existsSync(f.path),false);
  } finally {f.close();}
});

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
