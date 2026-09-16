import { normalizeIdentity } from './identity.ts';
import { CUSTOM_SLOTS } from './types.ts';
import { normalizeTagString } from '../tag_grammar.ts';
export interface RecordRow { collection: string; key: string; value: string }
export interface Snapshot { records: RecordRow[]; version: number }
export function legacyRecords(values: Record<string,string>, collection = 'document.yokohama.dmrg'): RecordRow[] {
  const rows = new Map<string,RecordRow>();
  const add = (c:string,k:string,v='') => rows.set(`${c}:${k}`,{collection:c,key:k,value:v});
  for (const name of ['allowlist','admins','tags']) {
    for (const line of (values[name] || '').split('\n')) {
      const raw = line.trim(); if (!raw || raw.startsWith('#')) continue;
      const key = name === 'tags' ? normalizeTagString(raw) : normalizeIdentity(raw);
      if (!key || (name === 'tags' && key === collection)) throw new Error(`Invalid ${name} entry: ${raw}`);
      add(name,key);
      if (name === 'admins') add('allowlist',key);
    }
  }
  for (const slot of CUSTOM_SLOTS) if (values[`custom:${slot}`] !== undefined) add('custom',slot,values[`custom:${slot}`]);
  for (const [key,value] of Object.entries(values)) if (key.startsWith('pin:')) {
    const pin = JSON.parse(value);
    if (!pin || typeof pin.uploader !== 'string' || !/^[0-9a-f]{64}$/.test(pin.uploader) || !(pin.id === null || typeof pin.id === 'string') || typeof pin.at !== 'number') throw new Error(`Invalid pin record: ${key}`);
    add('pins',key.slice(4),value);
  }
  return [...rows.values()];
}
export function planMerge(existing: RecordRow[], incoming: RecordRow[], overwriteHtml = false): RecordRow[] {
  const current = new Map(existing.map(row=>[`${row.collection}:${row.key}`,row]));
  return incoming.filter(row => {
    const old = current.get(`${row.collection}:${row.key}`);
    return !old || (overwriteHtml && row.collection === 'custom' && old.value !== row.value);
  });
}
// One statement makes all imported rows atomic on both SQLite and D1. The
// revision condition prevents overwriting edits made after the preview.
export function importStatement(rows: RecordRow[], version: number) {
  return {sql:`INSERT INTO records(collection,key,value)
    SELECT json_extract(value,'$.collection'),json_extract(value,'$.key'),json_extract(value,'$.value')
    FROM json_each(?) WHERE (SELECT version FROM store_revision WHERE id=1)=?
    ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value
    RETURNING collection,key`,params:[JSON.stringify(rows),version]};
}
export function bootstrapStatement(pubkey: string) {
  return {sql:`INSERT INTO records(collection,key,value)
    SELECT 'admins', ?, '' WHERE NOT EXISTS (SELECT 1 FROM records WHERE collection IN ('admins','meta'))
    RETURNING key`,params:[normalizeIdentity(pubkey,true)]};
}
