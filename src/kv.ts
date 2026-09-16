// KV-backed operator data, replacing the parent's on-disk list files
// (lib/allowlist.ts, lib/admins.ts, lib/tags.ts, lib/listfile.ts) and the
// custom/ HTML slots (lib/render.ts). Keys:
//
//   allowlist              one atproto handle/DID or nostr npub/hex per line
//   tags                   one newsgroup-style tag per line
//   admins                 same line format as the allowlist (CLI-only)
//   custom:<slot>          raw HTML (index, about, main-header, main-footer,
//                          sidebar-header, sidebar-footer) (CLI-only)
//
// The text format is identical to the parent's .txt files (`#` comments,
// blank lines), so scripts/seed-kv.sh can seed straight from them. Reads use
// KV's edge cache (cacheTtl 60 — the minimum), so admin edits propagate
// within ~60 s without a redeploy; admin read-modify-write cycles bypass the
// cache. NOTE: unlike the parent's per-path promise queue (listfile.ts), KV
// has no cross-request write serialization and is eventually consistent —
// two admins racing can lose one edit. Acceptable for the intended
// single-admin use; the per-user rate limit narrows the window.

import type { Env } from "./env.ts";
import { getConfig } from "./config.ts";
import { isNostrAllowlistEntry, parseNostrAllowlist } from "./nostr.ts";
import type { UnifiedSession } from "./session.ts";
import { MAX_TAGS_PER_RECORD, normalizeTagString } from "./tag_grammar.ts";

const CACHE_TTL_S = 60;

async function readKey(
  env: Env,
  key: string,
  { fresh = false } = {},
): Promise<string> {
  const text = fresh
    ? await env.VON_KV.get(key, { type: "text" })
    : await env.VON_KV.get(key, { type: "text", cacheTtl: CACHE_TTL_S });
  return text ?? "";
}

/** Parses list-file text: trimmed lines, `#` comments and blanks skipped. */
export function parseList(text: string): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
}

// ── Allowlist ───────────────────────────────────────────────────────────────
// Missing or empty key = NOBODY may log in (fail closed).

export async function loadAllowlist(
  env: Env,
  opts: { fresh?: boolean } = {},
): Promise<Set<string>> {
  return parseList(await readKey(env, "allowlist", opts));
}

/** The atproto-side entries of the allowlist (handles and DIDs). */
export function atprotoAllowlistEntries(allowlist: Set<string>): string[] {
  return [...allowlist].filter((e) => !isNostrAllowlistEntry(e));
}

/** True when at least one allowlist entry exists — otherwise login is off. */
export async function isLoginEnabled(env: Env): Promise<boolean> {
  return (await loadAllowlist(env)).size > 0;
}

/** Checks whether a nostr pubkey (hex) is on the allowlist. */
export async function isAllowedNostr(
  env: Env,
  pubkeyHex: string,
): Promise<boolean> {
  return parseNostrAllowlist(await loadAllowlist(env)).has(pubkeyHex);
}

// ── Admins ──────────────────────────────────────────────────────────────────
// Missing/empty key = no admins (fail closed: the admin UI 404s). Nothing in
// this codebase ever WRITES the key; only the operator does, via wrangler kv.

export async function loadAdmins(env: Env): Promise<Set<string>> {
  return parseList(await readKey(env, "admins"));
}

/** Admin check for a unified session, whichever protocol it came from. */
export async function isAdmin(env: Env, user: UnifiedSession): Promise<boolean> {
  const admins = await loadAdmins(env);
  if (admins.size === 0) return false;
  if (user.kind === "atproto") {
    return admins.has(user.did) || (!!user.handle && admins.has(user.handle));
  }
  return parseNostrAllowlist(admins).has(user.pubkey);
}

// ── Tags ────────────────────────────────────────────────────────────────────
// An EMPTY SET MEANS NO RESTRICTION (unlike the allowlist, which fails
// closed): every record, tagged or not, is shown.

/**
 * Normalizes a candidate tag and rejects the reserved lexicon-collection
 * name (it's the collection marker on nostr events, not a topic).
 */
export function normalizeTag(env: Env, raw: unknown): string | null {
  const tag = normalizeTagString(raw);
  if (!tag || tag === getConfig(env).collection) return null;
  return tag;
}

export async function loadAllowedTags(
  env: Env,
  opts: { fresh?: boolean } = {},
): Promise<Set<string>> {
  const tags = new Set<string>();
  for (const line of parseList(await readKey(env, "tags", opts))) {
    const tag = normalizeTag(env, line);
    if (tag) tags.add(tag);
    else console.warn(`tags: skipping invalid tag ${JSON.stringify(line)}`);
  }
  return tags;
}

// ── Custom HTML slots ───────────────────────────────────────────────────────
// Same slots as the parent's custom/ directory; a missing key renders as
// nothing. Edited via wrangler kv, applied without redeploy (≤ ~60 s).

const CUSTOM_SLOTS = new Set([
  "index",
  "about",
  "main-header",
  "main-footer",
  "sidebar-header",
  "sidebar-footer",
]);

export async function loadCustomSlot(env: Env, name: string): Promise<string> {
  if (!CUSTOM_SLOTS.has(name)) return "";
  return await readKey(env, `custom:${name}`);
}

// ── Admin writes (allowlist / tags only) ────────────────────────────────────
// Line-based edits with the exact semantics of the parent's listfile.ts:
// comments and blank lines are preserved verbatim, only exact-match entry
// lines are touched, appends are no-ops when the entry already exists.

function readLinesText(text: string): string[] {
  return text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
}

function isEntryLine(line: string, entry: string): boolean {
  const trimmed = line.trim();
  return trimmed === entry && !trimmed.startsWith("#");
}

export async function addListEntry(
  env: Env,
  key: "allowlist" | "tags",
  entry: string,
): Promise<void> {
  const lines = readLinesText(await readKey(env, key, { fresh: true }));
  if (lines.some((l) => isEntryLine(l, entry))) return;
  lines.push(entry);
  await env.VON_KV.put(key, lines.join("\n") + "\n");
}

export async function removeListEntry(
  env: Env,
  key: "allowlist" | "tags",
  entry: string,
): Promise<void> {
  const lines = readLinesText(await readKey(env, key, { fresh: true }));
  const kept = lines.filter((l) => !isEntryLine(l, entry));
  if (kept.length === lines.length) return;
  await env.VON_KV.put(key, kept.length === 0 ? "" : kept.join("\n") + "\n");
}

// Re-export for callers that only import kv.ts.
export { MAX_TAGS_PER_RECORD };
