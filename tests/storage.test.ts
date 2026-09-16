import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nip19 } from 'nostr-tools';
import { openSqlite } from '../src/storage/sqlite.ts';
import { bootstrapStatement, importStatement, legacyRecords, planMerge } from '../src/storage/transfer.ts';
import { normalizeIdentity } from '../src/storage/identity.ts';
import { createNostrSessionCookie } from '../src/nostr.ts';
import app from '../src/index.ts';
const alice='a'.repeat(64), bob='b'.repeat(64);
const schema=readFileSync('migrations/0001_store.sql','utf8');
function fixture() { const f=openSqlite(':memory:'); f.database.exec(schema); return f; }

test('bootstrap is atomic, normalizes npub, grants access, and cannot run twice',async()=>{
  const {store,database}=fixture();
  try {
    assert.equal((await store.db.all(bootstrapStatement(nip19.npubEncode(alice)))).length,1);
    assert.deepEqual(await store.list('admins'),[alice]);
    assert.deepEqual(await store.list('allowlist'),[alice]);
    assert.equal((await store.db.all(bootstrapStatement(bob))).length,0);
    assert.throws(()=>normalizeIdentity('nsec1secret',true));
    assert.throws(()=>normalizeIdentity('alice.example',true));
  } finally {database.close();}
});
test('last-admin removal rolls back access deletion; other admin removal revokes both',async()=>{
  const {store,database}=fixture();
  try {
    await store.add('admins',alice);
    await assert.rejects(store.remove('allowlist',alice),/last Nostr/);
    assert.deepEqual(await store.list('allowlist'),[alice]);
    await assert.rejects(store.remove('admins',alice),/last Nostr/);
    await store.add('admins',bob);
    await store.remove('allowlist',alice);
    assert.deepEqual(await store.list('admins'),[bob]);
    assert.deepEqual(await store.list('allowlist'),[bob]);
    await store.add('allowlist',nip19.npubEncode(bob));
    assert.deepEqual(await store.list('allowlist'),[bob]);
  } finally {database.close();}
});
test('independent list writes persist and first pin ownership cannot be stolen',async()=>{
  const {store,database}=fixture();
  try {
    await Promise.all([store.add('tags','sci.physics'),store.add('tags','sci.math')]);
    assert.deepEqual(await store.list('tags'),['sci.math','sci.physics']);
    await Promise.all([store.claimPin('cid',{uploader:alice,id:'1',at:1}),store.claimPin('cid',{uploader:bob,id:'2',at:2})]);
    assert.equal((await store.pin('cid'))?.uploader,alice);
    await store.deletePin('cid',bob);
    assert.ok(await store.pin('cid'));
    await store.deletePin('cid',alice);
    assert.equal(await store.pin('cid'),null);
  } finally {database.close();}
});
test('imports merge, grant admin access, preserve HTML and reject stale revisions atomically',async()=>{
  const {store,database}=fixture();
  try {
    await store.add('admins',alice);
    await store.setCustom('about','original');
    const incoming=legacyRecords({admins:nip19.npubEncode(bob),tags:'sci.math\nsci.physics','custom:about':'changed'});
    const existing=await store.db.all<any>({sql:'SELECT * FROM records'});
    const plan=planMerge(existing,incoming);
    assert.equal(plan.some(r=>r.collection==='custom'),false);
    const [{version}]=await store.db.all<{version:number}>({sql:'SELECT version FROM store_revision'});
    assert.equal((await store.db.all(importStatement(plan,version))).length,plan.length);
    assert.deepEqual(await store.list('admins'),[alice,bob]);
    assert.deepEqual(await store.list('allowlist'),[alice,bob]);
    assert.deepEqual(await store.list('tags'),['sci.math','sci.physics']);
    assert.equal((await store.db.all(importStatement([{collection:'tags',key:'stale',value:''}],version))).length,0);
    assert.equal((await store.list('tags')).includes('stale'),false);
    assert.equal(await store.custom('about'),'original');
    assert.equal(planMerge(existing,incoming,true).some(r=>r.collection==='custom'),true);
    assert.throws(()=>legacyRecords({admins:'not-a-key'}));
  } finally {database.close();}
});
test('SQLite configuration survives restarting the process connection',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'khamsin-test-')); const path=join(dir,'app.sqlite');
  try {
    const first=openSqlite(path); first.database.exec(schema); await first.store.add('admins',alice); first.database.close();
    const second=openSqlite(path); assert.deepEqual(await second.store.list('admins'),[alice]); second.database.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('admin routes require auth, reject cross-origin edits and protect last admin',async()=>{
  const {store,database}=fixture();
  try {
    await store.add('admins',alice);
    const secret='test-secret-which-is-at-least-32-characters';
    const env={STORE:store,COOKIE_SECRET:secret,BASE_URL:'http://localhost:8787'};
    const cookie=(await createNostrSessionCookie(alice,secret)).split(';')[0];
    const request=(path:string,body?:object,origin='http://localhost:8787')=>app.request(`http://localhost:8787${path}`,{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json'},body:body?JSON.stringify(body):undefined},env);
    assert.equal((await app.request('http://localhost:8787/admin',{},env)).status,401);
    assert.equal((await request('/admin')).status,200);
    assert.equal((await request('/admin/admins/add',{entry:bob},'https://other.example')).status,403);
    assert.equal((await request('/admin/allowlist/remove',{entry:alice})).status,409);
    assert.equal((await request('/admin/admins/add',{entry:nip19.npubEncode(bob)})).status,200);
    assert.equal((await request('/admin/custom',{slot:'about',html:'<p>Hello</p>'})).status,200);
    assert.equal(await store.custom('about'),'<p>Hello</p>');
    await store.remove('allowlist',alice);
    assert.equal((await request('/admin')).status,403);
  } finally {database.close();}
});
