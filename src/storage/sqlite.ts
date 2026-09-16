import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Statement } from './types.ts';
import { SqlStore } from './sql.ts';
export function openSqlite(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true,mode:0o700});
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const store = new SqlStore({
    async all<T>({sql,params}: Statement) { return database.prepare(sql).all(...params ?? []) as T[]; },
    async run({sql,params}) { database.prepare(sql).run(...params ?? []); },
  });
  return {database,store};
}
