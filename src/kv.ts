import type { Env } from "./env.ts";
import { getConfig } from "./config.ts";
import { isNostrAllowlistEntry, parseNostrAllowlist } from "./nostr.ts";
import type { UnifiedSession } from "./session.ts";
import { MAX_TAGS_PER_RECORD, normalizeTagString } from "./tag_grammar.ts";

import { getStore } from "./storage/index.ts";

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
  return new Set(await getStore(env).list("allowlist"));
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
// Missing/empty list = no admins (fail closed).

export async function loadAdmins(env: Env): Promise<Set<string>> {
  return new Set(await getStore(env).list("admins"));
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
  for (const line of await getStore(env).list("tags")) {
    const tag = normalizeTag(env, line);
    if (tag) tags.add(tag);
    else console.warn(`tags: skipping invalid tag ${JSON.stringify(line)}`);
  }
  return tags;
}

// ── Custom HTML slots ───────────────────────────────────────────────────────
// A missing slot renders as nothing. SQL edits apply without redeploy.

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
  return await getStore(env).custom(name);
}

export async function addListEntry(env: Env, key: "allowlist" | "tags", entry: string): Promise<void> {
  await getStore(env).add(key, entry);
}
export async function removeListEntry(env: Env, key: "allowlist" | "tags", entry: string): Promise<void> {
  await getStore(env).remove(key, entry);
}
export { MAX_TAGS_PER_RECORD };
