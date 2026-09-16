import type { Env } from '../env.ts';
import type { Store } from './types.ts';
import { KvStore } from './kv.ts';
import { d1Store } from './d1.ts';
export function getStore(env: Env): Store {
  if (env.STORE) return env.STORE;
  if (env.DB) return d1Store(env.DB);
  if (env.VON_KV) return new KvStore(env.VON_KV);
  throw new Error('No storage configured. Run npm run setup.');
}
