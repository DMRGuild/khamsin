import { serve, type HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import app from './index.ts';
import { openSqlite } from './storage/sqlite.ts';
import { getConfig } from './config.ts';
import type { Env } from './env.ts';

const dbPath = resolve(process.env.DATABASE_PATH || '.state/khamsin.sqlite');
if (!existsSync(dbPath)) throw new Error('Database not found. Run npm run setup -- --target sqlite first.');
const {database,store} = openSqlite(dbPath);
if (!database.prepare("SELECT 1 FROM records WHERE collection='admins' LIMIT 1").get()) {
  throw new Error('No administrator configured. Run npm run setup -- --target sqlite.');
}
const env: Env = {...process.env, STORE:store};
if (getConfig(env).cookieSecretUnsafe) throw new Error('Set a unique COOKIE_SECRET before starting the server.');
const web = new Hono<{Bindings:HttpBindings}>();
web.use('*', serveStatic({root:process.env.PUBLIC_DIR || './public'}));
web.all('*', c => app.fetch(c.req.raw, {...env, CLIENT_IP:c.env?.incoming?.socket?.remoteAddress || 'unknown'}));
const server = serve({fetch:web.fetch, port:Number(process.env.PORT || 8787), hostname:process.env.HOST || '127.0.0.1'}, info => {
  console.log(`Khamsin listening on http://${info.address}:${info.port}`);
});
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => server.close(() => { database.close(); process.exit(0); }));
