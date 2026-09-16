import type { ListName, PinRecord, SqlDriver, Store } from './types.ts';
import { CUSTOM_SLOTS } from './types.ts';
import { normalizeIdentity } from './identity.ts';
export class SqlStore implements Store {
  readonly editable = true;
  constructor(readonly db: SqlDriver) {}
  async list(name: ListName): Promise<string[]> {
    return (await this.db.all<{key:string}>({sql:'SELECT key FROM records WHERE collection=? ORDER BY key',params:[name]})).map(r=>r.key);
  }
  async add(name: ListName, entry: string): Promise<void> {
    const key = name === 'tags' ? entry : normalizeIdentity(entry, name === 'admins');
    await this.db.run({sql:'INSERT OR IGNORE INTO records(collection,key,value) VALUES (?,?,?)',params:[name,key,'']});
  }
  async remove(name: ListName, entry: string): Promise<void> {
    const key = name === 'tags' ? entry : normalizeIdentity(entry);
    await this.db.run({sql:'DELETE FROM records WHERE collection=? AND key=?',params:[name,key]});
  }
  async custom(slot: string): Promise<string> {
    const rows = await this.db.all<{value:string}>({sql:"SELECT value FROM records WHERE collection='custom' AND key=?",params:[slot]});
    return rows[0]?.value ?? '';
  }
  async setCustom(slot: string, html: string): Promise<void> {
    if (!(CUSTOM_SLOTS as readonly string[]).includes(slot)) throw new Error('Unknown HTML slot');
    await this.db.run({sql:"INSERT INTO records(collection,key,value) VALUES ('custom',?,?) ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value",params:[slot,html]});
  }
  async pin(cid: string): Promise<PinRecord|null> {
    const rows = await this.db.all<{value:string}>({sql:"SELECT value FROM records WHERE collection='pins' AND key=?",params:[cid]});
    return rows.length ? JSON.parse(rows[0].value) : null;
  }
  async claimPin(cid: string, record: PinRecord): Promise<void> {
    await this.db.run({sql:`INSERT INTO records(collection,key,value) VALUES ('pins',?,?)
      ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value
      WHERE json_extract(records.value,'$.uploader')=json_extract(excluded.value,'$.uploader')`,params:[cid,JSON.stringify(record)]});
  }
  async deletePin(cid: string, owner: string): Promise<void> {
    await this.db.run({sql:"DELETE FROM records WHERE collection='pins' AND key=? AND json_extract(value,'$.uploader')=?",params:[cid,owner]});
  }
}
