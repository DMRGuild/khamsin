// Nostr challenge-response login (NIP-42-style kind 22242) + logout.
// Ported from the parent's lib/routes/auth.ts minus the atproto OAuth flow;
// the challenge is stateless (HMAC) — see src/nostr.ts for the tradeoff.

import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { getConfig } from "../config.ts";
import { isAllowedNostr, isLoginEnabled } from "../kv.ts";
import {
  clearNostrSessionCookie,
  createNostrSessionCookie,
  newChallenge,
  rateLimit,
  validateLoginEvent,
} from "../nostr.ts";
import { clientIp, isSameOriginRequest } from "../session.ts";

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.get("/nostr/challenge", async (c) => {
    // Fail closed: an empty/missing allowlist disables login for everyone.
    if (!(await isLoginEnabled(c.env))) {
      return c.json({ error: "login disabled" }, 403);
    }
    if (!rateLimit(`challenge:${clientIp(c)}`, 10, 60_000)) {
      return c.json({ error: "rate limited" }, 429);
    }
    return c.json({
      challenge: await newChallenge(getConfig(c.env).cookieSecret),
    });
  });

  app.post("/nostr/login", async (c) => {
    if (!(await isLoginEnabled(c.env))) {
      return c.json({ error: "login disabled" }, 403);
    }
    if (!rateLimit(`nostr-login:${clientIp(c)}`, 10, 60_000)) {
      return c.json({ error: "rate limited" }, 429);
    }
    // JSON content type forces a CORS preflight for cross-origin senders; the
    // origin check blocks login-CSRF (being logged into an attacker's npub).
    if (!(c.req.header("content-type") || "").includes("application/json")) {
      return c.json({ error: "expected application/json" }, 400);
    }
    if (!isSameOriginRequest(c.req.raw, c.env)) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }

    const body = await c.req.raw.text();
    if (body.length > 8192) return c.json({ error: "body too large" }, 413);
    let event: unknown;
    try {
      event = JSON.parse(body)?.event;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    const cfg = getConfig(c.env);
    const result = await validateLoginEvent(event, {
      cookieSecret: cfg.cookieSecret,
      challengeTtlMs: cfg.challengeTtlMs,
      baseUrlHost: cfg.baseUrlHost,
    });
    if (!result.ok) {
      console.warn(`[nostr] login rejected: ${result.reason}`);
      // Uniform message: the specific failed check is not echoed to clients.
      return c.json({ error: "login verification failed" }, 401);
    }

    if (!(await isAllowedNostr(c.env, result.pubkey))) {
      return c.json({ error: "not allowlisted", npub: result.npub }, 403);
    }

    const cookie = await createNostrSessionCookie(
      result.pubkey,
      cfg.cookieSecret,
    );
    c.header("Set-Cookie", cookie);
    return c.json({ ok: true, npub: result.npub });
  });

  app.post("/logout", (c) => {
    // Send the browser back to the page the logout button was on
    // (same-origin referers only — a foreign or missing referer → home).
    let back = "/";
    try {
      const ref = new URL(c.req.header("referer") ?? "");
      if (ref.host === getConfig(c.env).baseUrlHost) {
        back = ref.pathname + ref.search;
      }
    } catch { /* unparsable referer → home */ }
    const headers = new Headers({ Location: back });
    headers.append("Set-Cookie", clearNostrSessionCookie());
    return new Response(null, { status: 303, headers });
  });
}
