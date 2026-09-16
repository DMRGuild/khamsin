import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { d1Store } from '../src/storage/d1.ts';
import { bootstrapStatement, importStatement, legacyRecords } from '../src/storage/transfer.ts';

test('D1 migration, bootstrap, import and permission triggers match SQLite',async()=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){ return new Response("ok"); }}',d1Databases:{DB:'test-db'},compatibilityDate:'2026-05-01'});
  try {
    const db=await mf.getD1Database('DB');
    // D1 exec splits on newlines, so submit complete statements including triggers.
    const schema=readFileSync('migrations/0001_store.sql','utf8').replace(/^--.*$/gm,'');
    const statements=schema.match(/CREATE TRIGGER[\s\S]*?END;|(?:CREATE TABLE|INSERT)[\s\S]*?;/g)!.map(s=>s.trim()).filter(Boolean);
    await db.batch(statements.map(s=>db.prepare(s)));
    const store=d1Store(db as unknown as D1Database);
    const alice='a'.repeat(64), bob='b'.repeat(64);
    const initial=bootstrapStatement(alice);
    assert.equal((await store.db.all(initial)).length,1);
    assert.equal((await store.db.all(bootstrapStatement(bob))).length,0);
    assert.deepEqual(await store.list('allowlist'),[alice]);
    await assert.rejects(store.remove('allowlist',alice),/last Nostr/);
    const [{version}]=await store.db.all<{version:number}>({sql:'SELECT version FROM store_revision'});
    const rows=legacyRecords({admins:bob,tags:'sci.math\nsci.physics'});
    assert.equal((await store.db.all(importStatement(rows,version))).length,rows.length);
    assert.deepEqual(await store.list('admins'),[alice,bob]);
    assert.deepEqual(await store.list('tags'),['sci.math','sci.physics']);
    await store.remove('allowlist',alice);
    assert.deepEqual(await store.list('admins'),[bob]);
    assert.equal((await store.db.all(importStatement(rows,version))).length,0);
  } finally { await mf.dispose(); }
});
