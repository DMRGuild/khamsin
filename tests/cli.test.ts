import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'smol-toml';

test('remote setup, import and export consume query rows rather than file-import statistics',()=>{
  const root=process.cwd();
  const dir=mkdtempSync(join(tmpdir(),'khamsin-remote-cli-'));
  try {
    copyFileSync('wrangler.toml.example',join(dir,'wrangler.toml.example'));
    const config=parse(readFileSync('wrangler.toml.example','utf8'));
    config.vars={...config.vars as object,BASE_URL:'https://archive.example'};
    config.account_id='a'.repeat(32);
    config.d1_databases=[{binding:'DB',database_name:'khamsin',database_id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}];
    writeFileSync(join(dir,'wrangler.toml'),stringify(config));
    mkdirSync(join(dir,'migrations'));
    copyFileSync('migrations/0001_store.sql',join(dir,'migrations/0001_store.sql'));
    mkdirSync(join(dir,'node_modules/wrangler/bin'),{recursive:true});
    // Emulate Wrangler's two remote execution contracts, using real SQL for
    // query results. No Cloudflare credentials or network requests are used.
    writeFileSync(join(dir,'node_modules/wrangler/bin/wrangler.js'),`
      const { readFileSync, writeFileSync, existsSync } = require('node:fs');
      const { DatabaseSync } = require('node:sqlite');
      const args=process.argv.slice(2);
      const output=value=>console.log(JSON.stringify(value));
      if (args[0]==='whoami') output({accounts:[{id:'a'.repeat(32),name:'Test'}]});
      else if (args[0]==='d1' && args[1]==='list') output([{name:'khamsin',uuid:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}]);
      else if (args[0]==='secret') {
        if (args[1]==='list') output(existsSync('cookie-set')?[{name:'COOKIE_SECRET'}]:[]);
        else if (args[1]==='put' && args[2]==='COOKIE_SECRET') {
          if (!readFileSync(0,'utf8').trim()) throw new Error('Missing secret input');
          writeFileSync('cookie-set','yes');
        } else throw new Error('Unexpected secret command');
      } else if (args[0]==='d1' && args.includes('--remote')) {
        const db=new DatabaseSync('remote.sqlite');
        try {
          if (args[1]==='migrations') db.exec(readFileSync('migrations/0001_store.sql','utf8'));
          else if (args[1]==='execute' && args.includes('--json')) {
            if (args.includes('--file')) {
              db.exec(readFileSync(args[args.indexOf('--file')+1],'utf8'));
              output([{success:true,results:[{'Total queries executed':1}]}]);
            } else if (args.includes('--command')) {
              const rows=db.prepare(args[args.indexOf('--command')+1]).all();
              output([{success:true,results:rows}]);
            } else throw new Error('Missing SQL input');
          } else throw new Error('Unexpected D1 command');
        } finally {db.close();}
      } else throw new Error('Unexpected Wrangler command: '+args.join(' '));
    `);
    const run=(args:string[])=>{
      const result=spawnSync(process.execPath,[resolve(root,'dist/config-cli.mjs'),...args],{cwd:dir,encoding:'utf8'});
      assert.equal(result.status,0,result.stdout+result.stderr);
      return result.stdout;
    };
    const admin='a'.repeat(64);
    assert.match(run(['setup','--target','remote','--admin',admin,'--defaults']),/Administrator and access permission registered/);
    assert.ok(existsSync(join(dir,'cookie-set')));
    assert.match(run(['setup','--target','remote','--defaults']),/Already initialized/);
    const incoming={tags:'sci.physics\n','custom:about':"<p>What's new? 日本語</p>"};
    writeFileSync(join(dir,'incoming.json'),JSON.stringify(incoming));
    assert.match(run(['import','--target','remote','--from','incoming.json']),/Preview only/);
    run(['export','--target','remote','--output','before.json']);
    assert.equal(JSON.parse(readFileSync(join(dir,'before.json'),'utf8')).tags,undefined);
    assert.match(run(['import','--target','remote','--from','incoming.json','--apply']),/Imported atomically/);
    run(['export','--target','remote','--output','after.json']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'after.json'),'utf8')),{
      ...incoming,admins:admin+'\n',allowlist:admin+'\n',
    });
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('setup is repeatable and import previews never write configuration',()=>{
  const root=process.cwd();
  const dir=mkdtempSync(join(tmpdir(),'khamsin-cli-test-'));
  try {
    mkdirSync(join(dir,'migrations'));
    copyFileSync('migrations/0001_store.sql',join(dir,'migrations/0001_store.sql'));
    const run=(args:string[],success=true)=>{
      const result=spawnSync(process.execPath,[resolve(root,'dist/config-cli.mjs'),...args],{
        cwd:dir,encoding:'utf8',env:{...process.env,DATABASE_PATH:join(dir,'app.sqlite')},
      });
      assert.equal(result.status===0,success,result.stdout+result.stderr);
      return result.stdout;
    };
    run(['setup','--target','sqlite','--admin','nsec1not-a-public-key'],false);
    run(['setup','--target','sqlite','--admin','a'.repeat(64)]);
    const secret=readFileSync(join(dir,'.env'),'utf8');
    assert.match(run(['setup','--target','sqlite','--admin','b'.repeat(64)]),/Already initialized/);
    assert.equal(readFileSync(join(dir,'.env'),'utf8'),secret);
    mkdirSync(join(dir,'input'));
    writeFileSync(join(dir,'input/tags.txt'),'sci.physics\n');
    run(['import','--target','sqlite','--from','missing-directory'],false);
    assert.match(run(['import','--target','sqlite','--from','input']),/Preview only/);
    run(['export','--target','sqlite','--output','before.json']);
    const before=JSON.parse(readFileSync(join(dir,'before.json'),'utf8'));
    assert.equal(before.tags,undefined);
    assert.equal(before.admins,'a'.repeat(64)+'\n');
    run(['import','--target','sqlite','--from','input','--apply']);
    run(['export','--target','sqlite','--output','after.json']);
    assert.equal(JSON.parse(readFileSync(join(dir,'after.json'),'utf8')).tags,'sci.physics\n');
    run(['export','--target','sqlite','--output','after.json'],false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('deployment preflight distinguishes commented D1 from active bindings',()=>{
  const dir=mkdtempSync(join(tmpdir(),'khamsin-deploy-test-'));
  try {
    mkdirSync(join(dir,'scripts'));
    symlinkSync(resolve('node_modules'),join(dir,'node_modules'),'dir');
    copyFileSync('scripts/check-deploy.mjs',join(dir,'scripts/check-deploy.mjs'));
    const check=(config:string,success:boolean)=>{
      writeFileSync(join(dir,'wrangler.toml'),config);
      const result=spawnSync(process.execPath,[join(dir,'scripts/check-deploy.mjs')],{cwd:dir,encoding:'utf8'});
      assert.equal(result.status===0,success,result.stderr);
    };
    const origin='[vars]\nBASE_URL="https://archive.example"\n';
    const kv='[[kv_namespaces]]\nbinding="VON_KV"\nid="'+'a'.repeat(32)+'"\n';
    const d1='[[d1_databases]]\nbinding="DB"\ndatabase_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"\n';
    check(origin+'# [[d1_databases]]\n# database_id="placeholder"\n'+kv,true);
    check(origin+d1,true);
    check(origin+d1+'[[kv_namespaces]]\nbinding="VON_KV"\n',false);
    check(origin+d1.replace('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000'),false);
    // Local preview state must not invalidate the production ID.
    check(origin+d1+'preview_database_id="00000000-0000-0000-0000-000000000000"\n',true);
    const invalidD1=d1.replace('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000');
    const otherD1=d1.replace('binding="DB"','binding="OTHER_DB"');
    const otherKv=kv.replace('binding="VON_KV"','binding="OTHER_KV"');
    const invalidKv='[[kv_namespaces]]\nbinding="VON_KV"\nid="placeholder"\n';
    for (const otherFirst of [true,false]) {
      const pair=(a:string,b:string)=>otherFirst?a+b:b+a;
      check(origin+pair(otherD1,d1),true);
      check(origin+pair(otherD1,invalidD1),false);
      check(origin+pair(otherKv,kv),true);
      check(origin+pair(otherKv,invalidKv),false);
      check(origin+d1+pair(otherKv,invalidKv),false);
    }
    check(origin+otherD1+otherKv,false);
    check(origin+otherD1+kv,true);
    check(origin+d1+otherKv,true);
    // Valid TOML formatting and comments should not change the result.
    check((origin+d1).replaceAll('"',"'").replace('[[d1_databases]]','[[d1_databases]] # production'),true);
    check(origin+d1.replace('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'),true);
    check('BASE_URL="https://archive.example"\n'+d1,false);
    check(origin+d1+'invalid = [',false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('configure-only CLI works from a fresh checkout without creating a database',()=>{
  const root=process.cwd();
  const dir=mkdtempSync(join(tmpdir(),'khamsin-config-only-'));
  try {
    copyFileSync('wrangler.toml.example',join(dir,'wrangler.toml.example'));
    const result=spawnSync(process.execPath,[resolve(root,'dist/config-cli.mjs'),'setup','--target','local','--defaults','--configure-only','--name','fresh-archive','--set','SKIN=dark'],{cwd:dir,encoding:'utf8'});
    assert.equal(result.status,0,result.stdout+result.stderr);
    const config=readFileSync(join(dir,'wrangler.toml'),'utf8');
    assert.match(config,/name = "fresh-archive"/);
    assert.match(config,/SKIN = "dark"/);
    assert.equal(existsSync(join(dir,'.wrangler')),false);
    assert.equal(existsSync(join(dir,'.env')),false);
    assert.equal(existsSync(join(dir,'.dev.vars')),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
