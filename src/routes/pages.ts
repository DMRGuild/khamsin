// Public HTML pages. Every page is a shell: the document listing, record
// detail data, and ticker are fetched client-side from the relays/PDSes.

import type { Hono } from "hono";
import type { AppEnv } from "../env.ts";
import { ATPROTO_DID_RE, getConfig } from "../config.ts";
import { isLoginEnabled, loadCustomSlot } from "../kv.ts";
import { neventFor } from "../nostr.ts";
import { htmlResponse, render } from "../render.ts";
import { getUnifiedSession, isUserAllowed } from "../session.ts";

// URL params are echoed into the page (escaped by eta / JSON-encoded), but
// gate their shape anyway: npub + 64-hex event id, or DID + atproto rkey.
const NPUB_RE = /^npub1[a-z0-9]{20,90}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ATPROTO_RKEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/;

function validRecordParams(did: string, rkey: string): boolean {
  if (NPUB_RE.test(did)) return HEX64_RE.test(rkey);
  if (ATPROTO_DID_RE.test(did)) return ATPROTO_RKEY_RE.test(rkey);
  return false;
}

export function registerPageRoutes(app: Hono<AppEnv>): void {
  app.get("/robots.txt", () => {
    const body = [
      "User-agent: *",
      "Allow: /",
      // Non-content routes: auth flows and JSON endpoints.
      "Disallow: /login",
      "Disallow: /logout",
      "Disallow: /nostr/",
      "Disallow: /settings",
      "Disallow: /admin",
      "Disallow: /api/",
      "Disallow: /upload",
      "",
    ].join("\n");
    return new Response(body, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  });

  // --- Main page: site header + client-rendered listing + login/upload ---

  app.get("/", async (c) => {
    const { user, setCookieHeader } = await getUnifiedSession(c.req.raw, c.env);
    const authedUser = user && (await isUserAllowed(c.env, user)) ? user : null;

    return htmlResponse(
      await render(c.env, "index", {
        authedSession: authedUser,
        session: user,
        loginEnabled: await isLoginEnabled(c.env),
        sidebar: true,
        customHtml: await loadCustomSlot(c.env, "index"),
        meta: { url: `${getConfig(c.env).baseUrl}/` },
      }),
      200,
      setCookieHeader,
    );
  });

  // --- About page: rendered from the custom:about KV slot ---

  app.get("/about", async (c) => {
    const { user, setCookieHeader } = await getUnifiedSession(c.req.raw, c.env);
    const authedUser = user && (await isUserAllowed(c.env, user)) ? user : null;

    const aboutHtml = await loadCustomSlot(c.env, "about");
    if (!aboutHtml) {
      return htmlResponse(
        await render(c.env, "error", { error: "Page not found." }),
        404,
        setCookieHeader,
      );
    }

    const cfg = getConfig(c.env);
    return htmlResponse(
      await render(c.env, "about", {
        authedSession: authedUser,
        session: user,
        loginEnabled: await isLoginEnabled(c.env),
        sidebar: true,
        aboutHtml,
        meta: {
          title: `About — ${cfg.siteName}`,
          url: `${cfg.baseUrl}/about`,
        },
      }),
      200,
      setCookieHeader,
    );
  });

  // --- Record detail page (shell; the browser fetches + verifies the data) ---

  app.get("/record/:did/:rkey", async (c) => {
    const { user, setCookieHeader } = await getUnifiedSession(c.req.raw, c.env);
    const authedUser = user && (await isUserAllowed(c.env, user)) ? user : null;

    const did = c.req.param("did");
    const rkey = c.req.param("rkey");
    if (!validRecordParams(did, rkey)) {
      return htmlResponse(
        await render(c.env, "error", { error: "Record not found." }),
        404,
        setCookieHeader,
      );
    }

    const cfg = getConfig(c.env);
    // nevent (with relay hints) is derivable from the URL alone — no relay
    // round-trip. External viewers use the hints to find the event.
    const nevent = did.startsWith("npub1")
      ? neventFor(did, rkey, cfg.relays)
      : null;
    return htmlResponse(
      await render(c.env, "record", {
        authedSession: authedUser,
        session: user,
        loginEnabled: await isLoginEnabled(c.env),
        sidebar: true,
        recordDid: did,
        recordRkey: rkey,
        nevent,
        currentDid: did,
        currentRkey: rkey,
        meta: {
          // SEO tradeoff, accepted: the shell doesn't know the record title;
          // the client updates document.title after fetching.
          title: cfg.siteName,
          url: `${cfg.baseUrl}/record/${did}/${rkey}`,
          type: "article",
        },
      }),
      200,
      setCookieHeader,
    );
  });

  // --- Settings (auth required; nostr-only for now) ---
  // Registered here but mounted behind requireAuth in index.ts.

  // --- /login stub: kept as the authbar form's no-JS action and as the
  // future home of atproto OAuth. ---

  app.get("/login", async (c) => {
    return htmlResponse(
      await render(c.env, "error", {
        title: "Login",
        error:
          "AT Protocol login is not available on this deployment (yet). Use a NIP-07 nostr extension to log in.",
      }),
      501,
    );
  });
}
