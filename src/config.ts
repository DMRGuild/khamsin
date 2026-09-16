// Env-derived configuration, adapted from the parent's lib/config.ts.
// No load-time process checks here (there is no process start on Workers) —
// the COOKIE_SECRET fail-closed guard runs as request middleware in index.ts.

import type { Env } from "./env.ts";

// Arweave tx ids are 43-char base64url; IPFS CIDs are base58 (Qm…) or base32
// (baf…). The alphabets don't overlap, so a bare identifier is unambiguous.
export const ARWEAVE_TXID_RE = /^[A-Za-z0-9_-]{43}$/;
export const IPFS_CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{20,})$/;

// atproto identifier shapes (admin allowlist editor + record-page params).
export const ATPROTO_DID_RE = /^did:[a-z]+:[a-zA-Z0-9._%:-]{1,250}$/;
export const ATPROTO_HANDLE_RE =
  /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/;

// Hardcoded lexicon constants shared with the parent deployment.
export const LINK_LEXICON_COLLECTION = "link.yokohama.dmrg";
export const NOSTR_PROFILE_DTAG = "profile.yokohama.dmrg";
export const LIGHTNING_LEXICON_COLLECTION = "lightning.yokohama.dmrg";

// The well-known dev fallback; only usable when BASE_URL points at localhost.
export const DEV_COOKIE_SECRET = "dev-secret-change-me-in-production!!";

function envFlag(v: string | undefined): boolean {
  return ["1", "true", "yes"].includes((v || "").trim().toLowerCase());
}

function list(v: string | undefined, fallback: string): string[] {
  return (v || fallback).split(",").map((s) => s.trim()).filter(Boolean);
}

export interface Config {
  baseUrl: string;
  baseUrlHost: string;
  /** The instance's origin tag: hostname of BASE_URL. */
  baseTag: string;
  siteName: string;
  siteDescription: string;
  skin: string;
  collection: string;
  relays: string[];
  challengeTtlMs: number;
  arweaveGateway: string;
  otsCalendars: string[];
  forceAllowTagless: boolean;
  /** Hides the zap UI (record-page tipjar + sidebar badges). Display only. */
  zapsDisabled: boolean;
  pinataEnabled: boolean;
  pinMaxFileBytes: number;
  cookieSecret: string;
  /** True when the cookie secret is missing/dev-default off localhost. */
  cookieSecretUnsafe: boolean;
}

export function getConfig(env: Env): Config {
  const baseUrl = env.BASE_URL || "http://localhost:8787";
  let host = "localhost:8787";
  let hostname = "localhost";
  try {
    const u = new URL(baseUrl);
    host = u.host;
    hostname = u.hostname;
  } catch { /* unparseable BASE_URL — keep localhost defaults */ }
  const cookieSecret = env.COOKIE_SECRET || DEV_COOKIE_SECRET;
  const local = hostname === "localhost" || hostname === "127.0.0.1" ||
    hostname === "[::1]";
  return {
    baseUrl,
    baseUrlHost: host,
    baseTag: hostname.toLowerCase(),
    siteName: env.SITE_NAME || "Khamsin",
    siteDescription: env.SITE_DESCRIPTION ||
      "A browser-first document archive.",
    skin: env.SKIN || "dark",
    collection: env.LEXICON_COLLECTION || "document.yokohama.dmrg",
    relays: list(
      env.NOSTR_RELAYS,
      "wss://relay.primal.net,wss://nos.lol,wss://relay.damus.io",
    ),
    challengeTtlMs: parseInt(env.NOSTR_CHALLENGE_TTL_MS || "300000"),
    arweaveGateway: env.ARWEAVE_GATEWAY || "https://arweave.net",
    otsCalendars: list(
      env.OTS_CALENDARS,
      "https://a.pool.opentimestamps.org,https://b.pool.opentimestamps.org,https://alice.btc.calendar.opentimestamps.org",
    ),
    forceAllowTagless: envFlag(env.FORCE_ALLOW_TAGLESS),
    zapsDisabled: envFlag(env.DISABLE_ZAPS),
    pinataEnabled: envFlag(env.ENABLE_PINATA) && !!env.PINATA_JWT,
    pinMaxFileBytes: parseInt(env.PIN_MAX_FILE_BYTES || String(64 * 1024 * 1024)),
    cookieSecret,
    // Fail closed: sessions sealed with a known secret are forgeable, so any
    // non-localhost deployment without a real secret refuses every request.
    cookieSecretUnsafe: cookieSecret === DEV_COOKIE_SECRET && !local,
  };
}
