// Account settings shell (nostr-only). All the actual work happens in the
// browser: link status is computed from public relay/PDS data, and link /
// display-name events (kind 30078) are signed via NIP-07 and published to
// the relays directly — no server-side settings POSTs exist on this
// deployment (the parent's /settings/* POSTs served the atproto OAuth side).

import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { getConfig } from "../config.ts";
import { isLoginEnabled } from "../kv.ts";
import { htmlResponse, render } from "../render.ts";
import type { UnifiedSession } from "../session.ts";

export function registerSettingsRoutes(authed: Hono<AppEnv>): void {
  authed.get("/settings", async (c) => {
    const user = c.get("user") as UnifiedSession;
    const setCookieHeader = c.get("setCookieHeader") as string;
    const cfg = getConfig(c.env);
    return htmlResponse(
      await render(c.env, "settings", {
        authedSession: user,
        session: user,
        loginEnabled: await isLoginEnabled(c.env),
        sidebar: true,
        meta: {
          title: `Settings — ${cfg.siteName}`,
          url: `${cfg.baseUrl}/settings`,
        },
      }),
      200,
      setCookieHeader || undefined,
    );
  });
}
