// The one public JSON endpoint the client-side data layer needs: the
// allowlist-derived author sets plus the tag policy, so the browser knows
// whom to query on the relays/PDSes and which records to show. The allowlist
// was already effectively public (it determines the public listing), so this
// discloses nothing new.

import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { getConfig } from "../config.ts";
import { atprotoAllowlistEntries, loadAllowedTags, loadAllowlist } from "../kv.ts";
import { parseNostrAllowlist } from "../nostr.ts";

export function registerApiRoutes(app: Hono<AppEnv>): void {
  app.get("/api/authors", async (c) => {
    const cfg = getConfig(c.env);
    const [allowlist, tags] = await Promise.all([
      loadAllowlist(c.env),
      loadAllowedTags(c.env),
    ]);
    return c.json(
      {
        // Hex pubkeys for relay `authors` filters.
        nostr: [...parseNostrAllowlist(allowlist)].sort(),
        // Raw handle/DID entries; the browser resolves handles → DIDs itself.
        atproto: atprotoAllowlistEntries(allowlist).sort(),
        tags: [...tags].sort(),
        baseTag: cfg.baseTag,
        forceAllowTagless: cfg.forceAllowTagless,
        collection: cfg.collection,
      },
      200,
      { "Cache-Control": "public, max-age=60" },
    );
  });
}
