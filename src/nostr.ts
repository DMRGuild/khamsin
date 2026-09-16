// Nostr support for the Workers port: challenge-response login (NIP-42-style
// kind 22242 events signed by a NIP-07 extension), sealed session cookies,
// and allowlist npub parsing. Adapted from the parent's lib/nostr.ts with the
// relay-reading half removed entirely — this server NEVER opens a WebSocket;
// all relay reads/publishes happen in the browser.
//
// Trust model notes (unchanged):
// - Identity is only ever derived from a BIP-340-verified event's `pubkey`;
//   nothing client-supplied is trusted before `verifyEvent` passes.
// - The relay list itself comes from operator configuration only.

import { nip19, verifyEvent } from "nostr-tools";
import type { Event as NostrEvent } from "nostr-tools";
import { sealData, unsealData } from "iron-session";

const HEX64_RE = /^[0-9a-f]{64}$/;

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** First value of the first tag named `name`, or null. */
function firstTag(ev: NostrEvent, name: string): string | null {
  const tag = ev.tags.find((t) => t[0] === name);
  return typeof tag?.[1] === "string" ? tag[1] : null;
}

export function pubkeyToNpub(pubkeyHex: string): string {
  return nip19.npubEncode(pubkeyHex);
}

/** Decodes an `npub1…` string to its hex pubkey, or null on malformed input. */
export function decodeNpub(npub: unknown): string | null {
  if (
    typeof npub !== "string" || npub.length > 100 || !npub.startsWith("npub1")
  ) {
    return null;
  }
  try {
    const decoded = nip19.decode(npub);
    return decoded.type === "npub" ? decoded.data : null;
  } catch {
    return null;
  }
}

/**
 * Encodes an `nevent` (bech32 event pointer) with relay hints. Needs no relay
 * round-trip — the record page derives it from its own URL parameters.
 */
export function neventFor(
  npub: string,
  idHex: string,
  relays: string[],
): string | null {
  if (!HEX64_RE.test(idHex)) return null;
  try {
    const decoded = nip19.decode(npub);
    if (decoded.type !== "npub") return null;
    return nip19.neventEncode({ id: idHex, author: decoded.data, relays });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rate limiting (in-memory, per key)
//
// On Workers this is per-isolate, best-effort only: isolates recycle and
// don't share state across the edge. The real gates are the HMAC challenge,
// the allowlist, and same-origin checks — this just blunts bursts.
// ---------------------------------------------------------------------------

const _rateBuckets = new Map<string, number[]>();
const RATE_BUCKETS_MAX = 10_000;

/** Sliding-window rate limiter. Returns true when the call is allowed. */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const stamps = (_rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (stamps.length >= max) {
    _rateBuckets.set(key, stamps);
    return false;
  }
  stamps.push(now);
  _rateBuckets.delete(key);
  _rateBuckets.set(key, stamps);
  if (_rateBuckets.size > RATE_BUCKETS_MAX) {
    const oldest = _rateBuckets.keys().next().value;
    if (oldest !== undefined) _rateBuckets.delete(oldest);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Login challenges — stateless HMAC (no storage on Workers)
//
// Shape: `<ts>.<nonce>.<hmac>` where hmac = HMAC-SHA256(secret,
// "von-challenge:<ts>.<nonce>"). The server verifies the MAC and the TTL
// instead of looking the challenge up in a store.
//
// Tradeoff vs the parent's single-use Map: a captured signed login event is
// replayable within the TTL window (default 5 min). Mitigations: TLS, the
// same-origin + JSON-content-type checks on /nostr/login, the event's own
// 300 s created_at skew gate, and the relay-tag host binding below (an event
// signed for another site never authenticates here).
// ---------------------------------------------------------------------------

const CHALLENGE_RE = /^\d{1,16}\.[0-9a-f]{32}\.[0-9a-f]{64}$/;

async function hmacHex(secret: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Constant-time-ish comparison of two equal-length hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function newChallenge(secret: string): Promise<string> {
  const ts = Date.now();
  const nonce = randomHex(16);
  const mac = await hmacHex(secret, `von-challenge:${ts}.${nonce}`);
  return `${ts}.${nonce}.${mac}`;
}

export async function verifyChallenge(
  secret: string,
  challenge: string,
  ttlMs: number,
): Promise<boolean> {
  if (!CHALLENGE_RE.test(challenge)) return false;
  const [tsStr, nonce, mac] = challenge.split(".");
  const expected = await hmacHex(secret, `von-challenge:${tsStr}.${nonce}`);
  if (!timingSafeEqualHex(mac, expected)) return false;
  const ts = Number(tsStr);
  const now = Date.now();
  return now - ts <= ttlMs && ts <= now + 60_000;
}

// ---------------------------------------------------------------------------
// Login event validation (kind 22242, NIP-42 style)
// ---------------------------------------------------------------------------

export const LOGIN_EVENT_KIND = 22242;
const LOGIN_EVENT_MAX_BYTES = 4096;
const CREATED_AT_SKEW_S = 300;

export type LoginValidation =
  | { ok: true; pubkey: string; npub: string }
  | { ok: false; reason: string };

/**
 * Validates a client-submitted login event. Order matters: structural checks
 * → signature (id recomputation + BIP-340) → freshness → challenge MAC →
 * domain binding. Identity comes exclusively from the verified `pubkey`.
 */
export async function validateLoginEvent(
  raw: unknown,
  opts: { cookieSecret: string; challengeTtlMs: number; baseUrlHost: string },
): Promise<LoginValidation> {
  const fail = (reason: string): LoginValidation => ({ ok: false, reason });

  // Structural validation before anything is trusted.
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const ev = raw as Record<string, unknown>;
  if (ev.kind !== LOGIN_EVENT_KIND) return fail("wrong kind");
  if (ev.content !== "") return fail("content must be empty");
  if (typeof ev.pubkey !== "string" || !HEX64_RE.test(ev.pubkey)) {
    return fail("bad pubkey");
  }
  if (typeof ev.id !== "string" || !HEX64_RE.test(ev.id)) return fail("bad id");
  if (typeof ev.sig !== "string" || !/^[0-9a-f]{128}$/.test(ev.sig)) {
    return fail("bad sig");
  }
  if (typeof ev.created_at !== "number" || !Number.isFinite(ev.created_at)) {
    return fail("bad created_at");
  }
  if (
    !Array.isArray(ev.tags) ||
    !ev.tags.every((t) =>
      Array.isArray(t) && t.every((x) => typeof x === "string")
    )
  ) {
    return fail("bad tags");
  }
  try {
    if (JSON.stringify(ev).length > LOGIN_EVENT_MAX_BYTES) {
      return fail("event too large");
    }
  } catch {
    return fail("unserializable event");
  }

  // Signature: recomputes the canonical id and checks BIP-340 — any tampering
  // with tags/created_at/pubkey after signing fails here.
  const event = ev as unknown as NostrEvent;
  try {
    if (!verifyEvent(event)) return fail("signature verification failed");
  } catch {
    return fail("signature verification failed");
  }

  const nowS = Math.floor(Date.now() / 1000);
  if (Math.abs(nowS - event.created_at) > CREATED_AT_SKEW_S) {
    return fail("stale created_at");
  }

  // Exactly one challenge tag, MAC-verified against our secret.
  const challengeTags = event.tags.filter((t) => t[0] === "challenge");
  const challenge = challengeTags.length === 1 ? challengeTags[0][1] : null;
  if (!challenge) return fail("bad challenge tag");
  if (!(await verifyChallenge(opts.cookieSecret, challenge, opts.challengeTtlMs))) {
    return fail("unknown or expired challenge");
  }

  // Domain binding: an event signed for another von instance (or captured on
  // a look-alike site) must not authenticate here.
  const relayTag = firstTag(event, "relay");
  if (!relayTag) return fail("missing relay tag");
  let relayHost: string;
  try {
    relayHost = new URL(relayTag).host;
  } catch {
    return fail("unparsable relay tag");
  }
  if (relayHost !== opts.baseUrlHost) return fail("relay tag host mismatch");

  return { ok: true, pubkey: event.pubkey, npub: nip19.npubEncode(event.pubkey) };
}

// ---------------------------------------------------------------------------
// Sessions (sealed cookie `nsid`, iron-session, same COOKIE_SECRET)
// ---------------------------------------------------------------------------

export const NOSTR_COOKIE_NAME = "nsid";
const SESSION_TTL_S = 60 * 60 * 24 * 14; // 14 days, sliding
const SESSION_ABSOLUTE_MAX_MS = 1000 * 60 * 60 * 24 * 90; // hard cap
const RESEAL_AFTER_MS = 1000 * 60 * 60; // refresh sliding window hourly

interface NostrSessionPayload {
  v: 1;
  t: "nostr"; // discriminator: a future atproto `sid` seal can never pass as nsid
  pubkey: string;
  createdAt: number;
  lastAccessed: number;
}

export interface NostrSession {
  pubkey: string;
  npub: string;
}

function sessionCookie(sealed: string): string {
  return `${NOSTR_COOKIE_NAME}=${sealed}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${SESSION_TTL_S}`;
}

export function clearNostrSessionCookie(): string {
  return `${NOSTR_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

export async function createNostrSessionCookie(
  pubkey: string,
  cookieSecret: string,
): Promise<string> {
  const now = Date.now();
  const payload: NostrSessionPayload = {
    v: 1,
    t: "nostr",
    pubkey,
    createdAt: now,
    lastAccessed: now,
  };
  const sealed = await sealData(payload, {
    password: cookieSecret,
    ttl: SESSION_TTL_S,
  });
  return sessionCookie(sealed);
}

/**
 * Restores a nostr session from the request's `nsid` cookie. Returns the
 * session plus, when the sliding window is due for a refresh, a replacement
 * `Set-Cookie` header. Any structural or expiry failure returns null.
 */
export async function getNostrSessionFromRequest(
  req: Request,
  cookieSecret: string,
): Promise<{ session: NostrSession | null; setCookieHeader?: string }> {
  const cookies = req.headers.get("cookie") || "";
  const match = cookies.match(
    new RegExp(`(?:^|;\\s*)${NOSTR_COOKIE_NAME}=([^;]+)`),
  );
  if (!match) return { session: null };

  let payload: NostrSessionPayload;
  try {
    payload = await unsealData<NostrSessionPayload>(match[1], {
      password: cookieSecret,
      ttl: SESSION_TTL_S,
    });
  } catch {
    return { session: null };
  }

  const now = Date.now();
  if (
    !payload || payload.v !== 1 || payload.t !== "nostr" ||
    typeof payload.pubkey !== "string" || !HEX64_RE.test(payload.pubkey) ||
    typeof payload.createdAt !== "number" ||
    typeof payload.lastAccessed !== "number" ||
    now - payload.createdAt > SESSION_ABSOLUTE_MAX_MS ||
    now - payload.lastAccessed > SESSION_TTL_S * 1000
  ) {
    return { session: null };
  }

  const session: NostrSession = {
    pubkey: payload.pubkey,
    npub: nip19.npubEncode(payload.pubkey),
  };

  if (now - payload.lastAccessed > RESEAL_AFTER_MS) {
    const sealed = await sealData(
      { ...payload, lastAccessed: now } satisfies NostrSessionPayload,
      { password: cookieSecret, ttl: SESSION_TTL_S },
    );
    return { session, setCookieHeader: sessionCookie(sealed) };
  }
  return { session };
}

// ---------------------------------------------------------------------------
// Allowlist parsing
// ---------------------------------------------------------------------------

/**
 * Extracts nostr pubkeys (hex) from allowlist lines. Accepts `npub1…`
 * (bech32) and bare 64-hex entries; anything else is left for the atproto
 * side. Malformed npub lines are skipped.
 */
export function parseNostrAllowlist(entries: Iterable<string>): Set<string> {
  const pubkeys = new Set<string>();
  for (const entry of entries) {
    if (entry.startsWith("npub1")) {
      const hex = decodeNpub(entry);
      if (hex) pubkeys.add(hex);
      else console.warn(`[nostr] skipping malformed npub allowlist entry: ${entry}`);
    } else if (HEX64_RE.test(entry)) {
      pubkeys.add(entry);
    }
  }
  return pubkeys;
}

/** True when the line belongs to the nostr side of the allowlist. */
export function isNostrAllowlistEntry(entry: string): boolean {
  return entry.startsWith("npub1") || HEX64_RE.test(entry);
}
