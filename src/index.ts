// von-workers — minimal von on Cloudflare Workers.
//
// The server renders shell pages (layout + skin + custom slots + auth state),
// handles nostr login, serves the /api/authors JSON, edits KV from /admin,
// and streams pandoc.wasm from R2. Everything data-shaped — the document
// listing, record details, ticker, zaps, author names — is fetched and
// verified in the browser, straight from the nostr relays and PDSes. The
// server never opens a WebSocket and never holds nostr keys.

import { Hono } from "hono";
import type { AppEnv } from "./env.ts";
import { getConfig } from "./config.ts";
import { htmlResponse, render } from "./render.ts";
import { requireAuth } from "./session.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerApiRoutes } from "./routes/api.ts";
import { registerAuthRoutes } from "./routes/auth.ts";
import { registerPageRoutes } from "./routes/pages.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerUploadRoutes } from "./routes/upload.ts";

const app = new Hono<AppEnv>();

// Fail closed (the parent does this at process start; Workers have no start):
// with the dev cookie secret off localhost, session cookies are forgeable, so
// refuse every request until COOKIE_SECRET is set.
app.use("*", async (c, next) => {
  if (getConfig(c.env).cookieSecretUnsafe) {
    console.error(
      "FATAL: COOKIE_SECRET is unset (or the dev default) and BASE_URL is " +
        "not localhost. Set it with `wrangler secret put COOKIE_SECRET`.",
    );
    return c.text("server misconfigured", 500);
  }
  await next();
});

// pandoc.wasm from R2 (58 MB — too large for static assets), cached at the
// edge so repeat loads don't touch the bucket.
app.get("/gentou/pandoc.wasm", async (c) => {
  // No R2 binding (bucket not provisioned yet): the viewer's pandoc
  // conversion degrades gracefully on a 404.
  if (!c.env.GENTOU_BUCKET) return c.notFound();
  const cacheKey = new Request(new URL(c.req.url).origin + "/gentou/pandoc.wasm");
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const obj = await c.env.GENTOU_BUCKET.get("pandoc.wasm");
  if (!obj) return c.notFound();
  const res = new Response(obj.body, {
    headers: {
      "Content-Type": "application/wasm",
      "Cache-Control": "public, max-age=31536000, immutable",
      ...(obj.httpEtag ? { ETag: obj.httpEtag } : {}),
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

// Public routes.
registerAuthRoutes(app);
registerPageRoutes(app);
registerApiRoutes(app);

// Authenticated routes. requireAuth is scoped to the exact paths (not "*")
// so unknown URLs still fall through to the 404 handler instead of a 401.
const authed = new Hono<AppEnv>();
authed.use("/upload", requireAuth);
authed.use("/unpin", requireAuth);
authed.use("/settings", requireAuth);
authed.use("/admin", requireAuth);
authed.use("/admin/*", requireAuth);
registerUploadRoutes(authed);
registerSettingsRoutes(authed);
registerAdminRoutes(authed);
app.route("/", authed);

app.notFound(async (c) =>
  htmlResponse(await render(c.env, "error", { error: "Page not found." }), 404)
);

app.onError(async (err, c) => {
  console.error("[app] unhandled error:", err);
  return htmlResponse(
    await render(c.env, "error", { error: "Something went wrong." }),
    500,
  );
});

export default app;
