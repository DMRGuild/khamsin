// Web admin: allowed-tags and allowlist editing, backed by KV. For users in
// the `admins` KV key only — that key itself is never editable here (CLI
// only). Non-admins get 404 (not 403) so the surface's existence isn't
// disclosed. Ported from the parent's lib/routes/admin.ts; the name/avatar
// row decoration moved to client JS (views/admin.eta) so the server does no
// relay/PDS lookups.

import type { Context, Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { ATPROTO_DID_RE, ATPROTO_HANDLE_RE, getConfig } from "../config.ts";
import {
  addListEntry,
  isAdmin,
  isLoginEnabled,
  loadAllowedTags,
  loadAllowlist,
  normalizeTag,
  removeListEntry,
} from "../kv.ts";
import { decodeNpub, isNostrAllowlistEntry, rateLimit } from "../nostr.ts";
import { htmlResponse, render } from "../render.ts";
import type { UnifiedSession } from "../session.ts";
import { isSameOriginRequest } from "../session.ts";

const MAX_ENTRY_LEN = 300;
const MAX_BODY_BYTES = 8192;

/** Bounded JSON body reader (the settings pattern from the parent). */
async function readJsonBody(
  c: Context<AppEnv>,
): Promise<Record<string, unknown> | null> {
  const body = await c.req.raw.text();
  if (body.length > MAX_BODY_BYTES) return null;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function registerAdminRoutes(authed: Hono<AppEnv>): void {
  // Admin gate for everything under /admin: non-admins get a plain 404.
  const gate = async (c: Context<AppEnv>, next: () => Promise<void>) => {
    const user = c.get("user") as UnifiedSession;
    if (!(await isAdmin(c.env, user))) return c.notFound();
    await next();
  };
  authed.use("/admin", gate);
  authed.use("/admin/*", gate);

  authed.get("/admin", async (c) => {
    const user = c.get("user") as UnifiedSession;
    const setCookieHeader = c.get("setCookieHeader") as string;
    const cfg = getConfig(c.env);
    // Fresh reads: the admin must see their own writes immediately, not the
    // 60 s edge cache.
    const [allowlist, tags] = await Promise.all([
      loadAllowlist(c.env, { fresh: true }),
      loadAllowedTags(c.env, { fresh: true }),
    ]);

    return htmlResponse(
      await render(c.env, "admin", {
        authedSession: user,
        session: user,
        loginEnabled: await isLoginEnabled(c.env),
        sidebar: true,
        allowlistEntries: [...allowlist],
        allowedTags: [...tags].sort(),
        forceAllowTagless: cfg.forceAllowTagless,
        // The identifiers of the logged-in admin, so the UI can warn before
        // they remove their own allowlist entry.
        selfEntries: user.kind === "nostr"
          ? [user.npub, user.pubkey]
          : [user.did, ...(user.handle ? [user.handle] : [])],
        meta: {
          title: `Admin — ${cfg.siteName}`,
          url: `${cfg.baseUrl}/admin`,
        },
      }),
      200,
      setCookieHeader || undefined,
    );
  });

  /** Shared guards for the admin POST endpoints. */
  const adminPostGuard = (
    c: Context<AppEnv>,
    user: UnifiedSession,
  ): Response | null => {
    if (!isSameOriginRequest(c.req.raw, c.env)) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }
    if (!rateLimit(`admin:${user.did}`, 10, 60_000)) {
      return c.json({ error: "rate limited" }, 429);
    }
    if (!(c.req.header("content-type") || "").includes("application/json")) {
      return c.json({ error: "expected application/json" }, 400);
    }
    return null;
  };

  const kvError = (c: Context<AppEnv>, err: unknown): Response => {
    console.error("[admin] KV write failed:", err);
    return c.json({ error: "could not write to KV" }, 500);
  };

  authed.post("/admin/tags/add", async (c) => {
    const user = c.get("user") as UnifiedSession;
    const guard = adminPostGuard(c, user);
    if (guard) return guard;
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "invalid JSON" }, 400);

    const tag = normalizeTag(c.env, body.tag);
    if (!tag) return c.json({ error: "invalid tag" }, 400);
    if (tag === getConfig(c.env).baseTag) {
      return c.json({
        ok: true,
        note: "the base-domain tag is always implicitly allowed",
        tags: [...await loadAllowedTags(c.env, { fresh: true })].sort(),
      });
    }
    try {
      await addListEntry(c.env, "tags", tag);
    } catch (err) {
      return kvError(c, err);
    }
    return c.json({
      ok: true,
      tags: [...await loadAllowedTags(c.env, { fresh: true })].sort(),
    });
  });

  authed.post("/admin/tags/remove", async (c) => {
    const user = c.get("user") as UnifiedSession;
    const guard = adminPostGuard(c, user);
    if (guard) return guard;
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "invalid JSON" }, 400);

    const tag = normalizeTag(c.env, body.tag);
    if (!tag) return c.json({ error: "invalid tag" }, 400);
    try {
      await removeListEntry(c.env, "tags", tag);
    } catch (err) {
      return kvError(c, err);
    }
    return c.json({
      ok: true,
      ...(tag === getConfig(c.env).baseTag
        ? { note: "the base-domain tag stays implicitly allowed" }
        : {}),
      tags: [...await loadAllowedTags(c.env, { fresh: true })].sort(),
    });
  });

  authed.post("/admin/allowlist/add", async (c) => {
    const user = c.get("user") as UnifiedSession;
    const guard = adminPostGuard(c, user);
    if (guard) return guard;
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "invalid JSON" }, 400);

    const entry = typeof body.entry === "string" ? body.entry.trim() : "";
    const valid = entry.length > 0 && entry.length <= MAX_ENTRY_LEN && (
      entry.startsWith("npub1")
        ? decodeNpub(entry) !== null
        : isNostrAllowlistEntry(entry) ||
          (entry.startsWith("did:")
            ? ATPROTO_DID_RE.test(entry)
            : ATPROTO_HANDLE_RE.test(entry))
    );
    if (!valid) {
      return c.json({ error: "not a valid handle, DID, or npub" }, 400);
    }
    try {
      await addListEntry(c.env, "allowlist", entry);
    } catch (err) {
      return kvError(c, err);
    }
    return c.json({
      ok: true,
      entries: [...await loadAllowlist(c.env, { fresh: true })],
    });
  });

  authed.post("/admin/allowlist/remove", async (c) => {
    const user = c.get("user") as UnifiedSession;
    const guard = adminPostGuard(c, user);
    if (guard) return guard;
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "invalid JSON" }, 400);

    const entry = typeof body.entry === "string" ? body.entry.trim() : "";
    if (!entry || entry.length > MAX_ENTRY_LEN) {
      return c.json({ error: "invalid entry" }, 400);
    }
    try {
      await removeListEntry(c.env, "allowlist", entry);
    } catch (err) {
      return kvError(c, err);
    }
    return c.json({
      ok: true,
      entries: [...await loadAllowlist(c.env, { fresh: true })],
    });
  });
}
