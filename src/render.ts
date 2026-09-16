// The shared render() pipeline that wraps every page in the base layout,
// ported from the parent's lib/render.ts. Custom HTML slots come from KV
// (edits apply without redeploy); skin CSS is a bundled string keyed by the
// SKIN var and inlined into <head>, exactly like the parent.

import type { Env } from "./env.ts";
import {
  getConfig,
  LIGHTNING_LEXICON_COLLECTION,
  LINK_LEXICON_COLLECTION,
  NOSTR_PROFILE_DTAG,
} from "./config.ts";
import { isAdmin, loadAllowedTags, loadCustomSlot } from "./kv.ts";
import type { UnifiedSession } from "./session.ts";
import { getEta, SKINS } from "./templates.ts";

/**
 * Convenience wrapper: text/html Response with optional status + Set-Cookie.
 */
export function htmlResponse(
  body: string,
  status = 200,
  setCookieHeader?: string,
): Response {
  const res = new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
  if (setCookieHeader) {
    res.headers.set("Set-Cookie", setCookieHeader);
  }
  return res;
}

/**
 * Renders `@<template>` into the base layout (`@layout`). Always injects the
 * site branding, the shared client config, and the custom header/footer
 * slots. Pages that want the sidebar column (all real pages; error/denied
 * don't) pass `sidebar: true` — the listing itself is rendered client-side
 * from the relays/PDSes, so the server only ships the shell.
 */
export async function render(
  env: Env,
  template: string,
  data: Record<string, unknown> = {},
): Promise<string> {
  const cfg = getConfig(env);
  const [mainHeader, mainFooter, sidebarHeader, sidebarFooter, allowedTags] =
    await Promise.all([
      loadCustomSlot(env, "main-header"),
      loadCustomSlot(env, "main-footer"),
      loadCustomSlot(env, "sidebar-header"),
      loadCustomSlot(env, "sidebar-footer"),
      loadAllowedTags(env),
    ]);
  const shared = {
    arweaveGateway: cfg.arweaveGateway,
    nostrRelays: cfg.relays,
    otsCalendars: cfg.otsCalendars,
    // Collection names the client needs for PDS reads, AT-URIs, and the
    // kind-30078 d-tags.
    lightningCollection: LIGHTNING_LEXICON_COLLECTION,
    linkCollection: LINK_LEXICON_COLLECTION,
    profileDTag: NOSTR_PROFILE_DTAG,
    documentCollection: cfg.collection,
    loginEnabled: data.loginEnabled ?? null,
    // Newsgroup tags: the upload form's checkbox list. Re-read per render
    // (KV edge cache ≤ 60 s) so admin edits show up quickly.
    allowedTags: [...allowedTags].sort(),
    baseTag: cfg.baseTag,
    // Shows the /admin link in the authbar for admins only.
    isAdminUser: data.authedSession
      ? await isAdmin(env, data.authedSession as UnifiedSession)
      : false,
    // Whether the IPFS (Pinata) storage option exists on this deployment.
    pinataEnabled: cfg.pinataEnabled,
    // Display switch: hides the record-page tipjar and the sidebar's ⚡
    // badges (client reads it via window.VON too).
    zapsDisabled: cfg.zapsDisabled,
  };
  const eta = getEta();
  const name = template.startsWith("@") ? template : `@${template}`;
  const body = eta.render(name, { ...shared, ...data });
  return eta.render("@layout", {
    siteName: cfg.siteName,
    siteDescription: cfg.siteDescription,
    skinCss: SKINS[cfg.skin] ?? "",
    ...shared,
    body,
    meta: data.meta,
    customMainHeader: mainHeader,
    customMainFooter: mainFooter,
    customSidebarHeader: sidebarHeader,
    customSidebarFooter: sidebarFooter,
    // The sidebar column shell (authbar + client-rendered document list).
    // Placement stays pure CSS (`body:has(.doc-sidebar)`) — skin-agnostic.
    sidebar: data.sidebar ?? false,
    currentDid: data.currentDid ?? null,
    currentRkey: data.currentRkey ?? null,
    // Auth state for the account panel that sits atop the sidebar.
    authedSession: data.authedSession ?? null,
    session: data.session ?? null,
  });
}
