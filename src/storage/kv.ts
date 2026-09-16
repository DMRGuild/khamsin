// Compatibility for existing deployments. KV retains eventual consistency and
// cannot make read/modify/write atomic. New installations use SQL.
import type { ListName, PinRecord, Store } from './types.ts';
export class KvStore implements Store {
  readonly editable = false;
  constructor(private kv: KVNamespace) {}
  async list(name: ListName): Promise<string[]> {
    return [...new Set((await this.kv.get(name) ?? '').split('\n').map(s=>s.trim()).filter(s=>s && !s.startsWith('#')))];
  }
  async add(name: ListName, entry: string): Promise<void> {
    const text = await this.kv.get(name) ?? '';
    if ((await this.list(name)).includes(entry)) return;
    await this.kv.put(name, text + (text && !text.endsWith('\n') ? '\n' : '') + entry + '\n');
  }
  async remove(name: ListName, entry: string): Promise<void> {
    const text = await this.kv.get(name) ?? '';
    await this.kv.put(name, text.split('\n').filter(line=>line.trim()!==entry).join('\n'));
  }
  async custom(slot: string): Promise<string> { return await this.kv.get(`custom:${slot}`) ?? ''; }
  async setCustom(): Promise<void> { throw new Error('Migrate to SQL to edit HTML in the application'); }
  async pin(cid: string): Promise<PinRecord|null> { return this.kv.get(`pin:${cid}`, 'json'); }
  async claimPin(cid: string, record: PinRecord): Promise<void> {
    const existing = await this.pin(cid);
    if (!existing || existing.uploader === record.uploader) await this.kv.put(`pin:${cid}`,JSON.stringify(record));
  }
  async deletePin(cid: string, owner: string): Promise<void> {
    if ((await this.pin(cid))?.uploader === owner) await this.kv.delete(`pin:${cid}`);
  }
}
