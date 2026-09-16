// Worker bindings + Hono context types. Secrets (COOKIE_SECRET, PINATA_JWT)
// arrive through the same interface but must be set via `wrangler secret`,
// never in wrangler.toml's [vars].

import type { UnifiedSession } from "./session.ts";

export interface Env {
  // Bindings
  VON_KV: KVNamespace;
  /** Absent until R2 is activated + the wrangler.toml block is uncommented. */
  GENTOU_BUCKET?: R2Bucket;
  ASSETS: Fetcher;

  // Vars (wrangler.toml)
  BASE_URL?: string;
  SITE_NAME?: string;
  SITE_DESCRIPTION?: string;
  SKIN?: string;
  LEXICON_COLLECTION?: string;
  NOSTR_RELAYS?: string;
  NOSTR_CHALLENGE_TTL_MS?: string;
  ARWEAVE_GATEWAY?: string;
  OTS_CALENDARS?: string;
  FORCE_ALLOW_TAGLESS?: string;
  DISABLE_ZAPS?: string;
  ENABLE_PINATA?: string;
  PIN_MAX_FILE_BYTES?: string;

  // Secrets (wrangler secret / .dev.vars)
  COOKIE_SECRET?: string;
  PINATA_JWT?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: UnifiedSession;
    setCookieHeader: string;
  };
};
