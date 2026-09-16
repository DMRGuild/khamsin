// Shared application. Platform bindings are assembled by runtime entry points.
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
        "not localhost. Set COOKIE_SECRET in your deployment environment.",
    );
    return c.text("server misconfigured", 500);
  }
  await next();
});

app.get("/gentou/pandoc.wasm", c =>
  c.env.serveWasm ? c.env.serveWasm(c.req.raw) : c.notFound());

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
