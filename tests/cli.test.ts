import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
    copyFileSync('scripts/check-deploy.mjs',join(dir,'scripts/check-deploy.mjs'));
    const check=(config:string,success:boolean)=>{
      writeFileSync(join(dir,'wrangler.toml'),config);
      const result=spawnSync(process.execPath,[join(dir,'scripts/check-deploy.mjs')],{cwd:dir,encoding:'utf8'});
      assert.equal(result.status===0,success,result.stderr);
    };
    const origin='BASE_URL="https://archive.example"\n';
    const kv='[[kv_namespaces]]\nbinding="VON_KV"\nid="'+'a'.repeat(32)+'"\n';
    const d1='[[d1_databases]]\nbinding="DB"\ndatabase_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"\n';
    check(origin+'# [[d1_databases]]\n# database_id="placeholder"\n'+kv,true);
    check(origin+d1,true);
    check(origin+d1+'[[kv_namespaces]]\nbinding="VON_KV"\n',false);
    check(origin+d1.replace('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000'),false);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
