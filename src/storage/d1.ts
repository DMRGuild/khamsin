import { SqlStore } from './sql.ts';
export function d1Store(db: D1Database): SqlStore {
  // Every operation starts at the primary, including permission checks.
  const prepare = (sql: string, params: (string|number|null)[] = []) => db.withSession('first-primary').prepare(sql).bind(...params);
  return new SqlStore({
    async all<T>({sql,params}: {sql:string;params?:(string|number|null)[]}) {
      return (await prepare(sql,params).all<T>()).results;
    },
    async run({sql,params}) { await prepare(sql,params).run(); },
  });
}
