// Sessions and auth. Nostr-only today, but the UnifiedSession shape (and the
// fixed sid-before-nsid precedence) is kept from the parent so an atproto
// OAuth client can slot back in without touching callers.

import type { Context, Next } from "hono";
import type { AppEnv, Env } from "./env.ts";
import { getConfig } from "./config.ts";
import { isAllowedNostr, loadAllowlist } from "./kv.ts";
import { getNostrSessionFromRequest } from "./nostr.ts";
import { htmlResponse, render } from "./render.ts";

/**
 * One logged-in identity, whichever protocol it came from. For nostr users
 * `did`/`handle` carry the npub so templates and ownership checks written for
 * atproto identifiers keep working unchanged. The atproto variant is unused
 * today (no OAuth on this deployment yet) but kept so adding it later only
 * touches getUnifiedSession.
 */
export type UnifiedSession =
  | { kind: "atproto"; did: string; handle?: string }
  | { kind: "nostr"; did: string; handle: string; pubkey: string; npub: string };

/**
 * Resolves the request's session. Precedence is fixed (a request carrying
 * both cookies never flip-flops):
 *   1. atproto `sid` (future — OAuth client goes here when added)
 *   2. nostr `nsid`
 */
export async function getUnifiedSession(
  req: Request,
  env: Env,
): Promise<{ user: UnifiedSession | null; setCookieHeader?: string }> {
  const nostr = await getNostrSessionFromRequest(
    req,
    getConfig(env).cookieSecret,
  );
  if (nostr.session) {
    return {
      user: {
        kind: "nostr",
        did: nostr.session.npub,
        handle: nostr.session.npub,
        pubkey: nostr.session.pubkey,
        npub: nostr.session.npub,
      },
      setCookieHeader: nostr.setCookieHeader,
    };
  }
  return { user: null };
}

/** Allowlist check for a unified session, whichever protocol it came from. */
export async function isUserAllowed(
  env: Env,
  user: UnifiedSession,
): Promise<boolean> {
  if (user.kind === "atproto") {
    const allowlist = await loadAllowlist(env);
    return allowlist.has(user.did) ||
      (!!user.handle && allowlist.has(user.handle));
  }
  return await isAllowedNostr(env, user.pubkey);
}

/**
 * Cross-origin guard for the JSON endpoints. Browsers always attach Origin
 * to cross-origin POSTs (and same-origin POSTs from modern browsers);
 * Sec-Fetch-Site covers the rest. Non-browser clients without either header
 * pass — they can't ride a victim's cookies anyway.
 */
export function isSameOriginRequest(req: Request, env: Env): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === getConfig(env).baseUrlHost;
    } catch {
      return false;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

/** Client IP for rate limiting (Cloudflare sets CF-Connecting-IP). */
export function clientIp(c: Context<AppEnv>): string {
  return c.env.CLIENT_IP || "unknown";
}

/**
 * Middleware for authenticated routes: 401 without a session, 403 (denied
 * page) when not allowlisted, else stores `user`/`setCookieHeader` in context.
 */
export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const { user, setCookieHeader } = await getUnifiedSession(c.req.raw, c.env);

  if (!user) {
    return htmlResponse(
      await render(c.env, "error", { error: "Authentication required." }),
      401,
    );
  }

  if (!(await isUserAllowed(c.env, user))) {
    return htmlResponse(
      await render(c.env, "denied", {
        did: user.kind === "atproto" ? user.did : undefined,
        handle: user.kind === "atproto" ? user.handle : undefined,
        npub: user.kind === "nostr" ? user.npub : undefined,
      }),
      403,
    );
  }

  c.set("user", user);
  c.set("setCookieHeader", setCookieHeader || "");
  await next();
}
