import app from './index.ts';
import type { Env } from './env.ts';
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const runtime: Env = {...env, CLIENT_IP: request.headers.get('cf-connecting-ip') || 'unknown'};
    runtime.serveWasm = async req => {
      if (!env.GENTOU_BUCKET) return new Response('Not found', {status:404});
      const key = new Request(new URL(req.url).origin + '/gentou/pandoc.wasm');
      const hit = await caches.default.match(key);
      if (hit) return hit;
      const obj = await env.GENTOU_BUCKET.get('pandoc.wasm');
      if (!obj) return new Response('Not found', {status:404});
      const response = new Response(obj.body, {headers:{
        'Content-Type':'application/wasm', 'Cache-Control':'public, max-age=31536000, immutable', ETag:obj.httpEtag,
      }});
      ctx.waitUntil(caches.default.put(key,response.clone()));
      return response;
    };
    return app.fetch(request,runtime,ctx);
  },
};
