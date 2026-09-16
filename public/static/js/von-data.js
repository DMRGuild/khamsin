// Client-side data layer for the Workers port of von. The server only ships
// page shells; this module gathers the actual records — nostr kind-1063
// events from the configured relays and atproto repo records from the
// authors' PDSes — verifies them, applies the tag policy, and decorates
// display names. It is the browser-side port of the parent's lib/nostr.ts
// (eventToRecord, delete handling), lib/records.ts (aggregation, sorting)
// and lib/linkage.ts (decorateRecords).
//
// Relay/PDS data is HOSTILE INPUT: every field is format-gated and length-
// capped here, and callers must render strings via textContent only.
//
// Depends on window.vonLn (relay/PDS plumbing) and window.VON (config), both
// provided by the layout before this module loads.

const ln = () => window.vonLn;
const cfg = () => window.VON;

// ── Shared validation gates (mirror the server's src/config.ts) ─────────────
export const IPFS_CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{20,})$/;
export const ARWEAVE_TXID_RE = /^[A-Za-z0-9_-]{43}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ATPROTO_RKEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/;

// Newsgroup-tag grammar (mirror of src/tag_grammar.ts).
const TAG_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_TAG_LEN = 100;
const MAX_TAGS_PER_RECORD = 20;

export function normalizeTagString(raw) {
  if (typeof raw !== 'string') return null;
  const tag = raw.trim().toLowerCase();
  if (!tag || tag.length > MAX_TAG_LEN || !TAG_RE.test(tag)) return null;
  return tag;
}

// Length caps for relay-derived strings (mirror of lib/nostr.ts).
const MAX_TITLE_LEN = 300;
const MAX_FILENAME_LEN = 300;
const MAX_DESCRIPTION_LEN = 10_000;
const MAX_OTS_B64_LEN = 90_000; // ~64 KiB binary
const MAX_ARTIFACTS = 1000;
const MAX_ARTIFACT_LEN = 500;
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

function firstTag(ev, name) {
  const tag = (ev.tags || []).find((t) => t[0] === name);
  return typeof tag?.[1] === 'string' ? tag[1] : null;
}

function clampString(v, max) {
  if (v === null) return null;
  return v.length <= max ? v : null; // oversized relay data is dropped, not truncated
}

// ── /api/authors (memoized per page load) ───────────────────────────────────

let _authorsPromise = null;

/**
 * The allowlist-derived author sets plus tag policy, from the server:
 * { nostr: [hex], atproto: [entries], tags: [...], baseTag, forceAllowTagless,
 *   collection }.
 */
export function getAuthors() {
  _authorsPromise ??= fetch('/api/authors').then(async (res) => {
    if (!res.ok) throw new Error(`authors fetch failed (${res.status})`);
    const data = await res.json();
    return {
      nostr: Array.isArray(data.nostr) ? data.nostr.filter((p) => HEX64_RE.test(p)) : [],
      atproto: Array.isArray(data.atproto) ? data.atproto.filter((e) => typeof e === 'string') : [],
      tags: new Set((Array.isArray(data.tags) ? data.tags : []).map(normalizeTagString).filter(Boolean)),
      baseTag: typeof data.baseTag === 'string' ? data.baseTag : '',
      forceAllowTagless: data.forceAllowTagless === true,
    };
  });
  return _authorsPromise;
}

// ── Tag filter (mirror of lib/tags.ts recordPassesTagFilter) ────────────────

export function recordTags(value) {
  if (!Array.isArray(value.tags)) return [];
  const tags = new Set();
  for (const raw of value.tags) {
    const tag = normalizeTagString(raw);
    if (tag && tag !== cfg().collection) tags.add(tag);
    if (tags.size >= MAX_TAGS_PER_RECORD) break;
  }
  return [...tags];
}

export function recordPassesTagFilter(value, authors) {
  if (authors.tags.size === 0) return true;
  const tags = recordTags(value);
  if (tags.length === 0) return authors.forceAllowTagless;
  return tags.some((t) => t === authors.baseTag || authors.tags.has(t));
}

// ── kind-1063 → record (client port of lib/nostr.ts eventToRecord) ─────────

export function eventToRecord(ev) {
  const collection = cfg().collection;
  const cidRaw = firstTag(ev, 'cid');
  const arweaveRaw = firstTag(ev, 'arweave');
  const cid = cidRaw && IPFS_CID_RE.test(cidRaw) ? cidRaw : null;
  const arweave = arweaveRaw && ARWEAVE_TXID_RE.test(arweaveRaw) ? arweaveRaw : null;
  if (!cid && !arweave) return null;

  const title = clampString(firstTag(ev, 'title'), MAX_TITLE_LEN);
  const fileName = clampString(firstTag(ev, 'fileName'), MAX_FILENAME_LEN);
  const otsRaw = firstTag(ev, 'ots');
  const ots = otsRaw && otsRaw.length <= MAX_OTS_B64_LEN && BASE64_RE.test(otsRaw)
    ? otsRaw
    : null;
  const sigOtsRaw = firstTag(ev, 'sigOts');
  const sigOts = sigOtsRaw && sigOtsRaw.length <= MAX_OTS_B64_LEN &&
      BASE64_RE.test(sigOtsRaw)
    ? sigOtsRaw
    : null;
  const sizeRaw = firstTag(ev, 'size');
  const size = sizeRaw && /^\d{1,15}$/.test(sizeRaw) ? Number(sizeRaw) : null;
  const artifacts = (ev.tags || [])
    .filter((t) => t[0] === 'artifact' && typeof t[1] === 'string')
    .map((t) => t[1])
    .filter((a) => a.length > 0 && a.length <= MAX_ARTIFACT_LEN)
    .slice(0, MAX_ARTIFACTS);
  const description = typeof ev.content === 'string'
    ? ev.content.slice(0, MAX_DESCRIPTION_LEN)
    : '';
  // Topic tags share the `t` namespace with the collection marker.
  const tags = new Set();
  for (const t of ev.tags || []) {
    if (t[0] !== 't' || typeof t[1] !== 'string' || t[1] === collection) continue;
    const tag = normalizeTagString(t[1]);
    if (tag) tags.add(tag);
    if (tags.size >= MAX_TAGS_PER_RECORD) break;
  }

  const npub = ln().hexToNpub(ev.pubkey);
  if (!npub) return null;
  const value = {
    title: title || '',
    description,
    fileName: fileName || '',
    createdAt: new Date(ev.created_at * 1000).toISOString(),
  };
  if (cid) {
    value.cid = cid;
    if (artifacts.length > 0) value.artifacts = artifacts;
  } else {
    value.arweave = arweave;
    if (size !== null) value.arSize = size;
  }
  if (ots) value.ots = ots;
  if (sigOts) value.sigOts = sigOts;
  if (tags.size > 0) value.tags = [...tags];

  return { uri: `nostr:${ev.id}`, rkey: ev.id, did: npub, handle: npub, value };
}

// ── Nostr listing (kind 1063 + NIP-09 deletes) ──────────────────────────────

export async function fetchNostrRecords(authors) {
  if (authors.nostr.length === 0) return [];
  const relays = cfg().relays;
  const [fileEvents, deleteEvents] = await Promise.all([
    ln().relayQuery(relays, {
      kinds: [1063],
      authors: authors.nostr,
      '#t': [cfg().collection],
      limit: 500,
    }, 5000),
    ln().relayQuery(relays, { kinds: [5], authors: authors.nostr, limit: 500 }, 5000),
  ]);

  const verifyEvent = await ln().verifyEventFn();

  // Deletions only count against the same author's events (NIP-09).
  const deleted = new Set();
  for (const del of deleteEvents) {
    if (del.kind !== 5) continue;
    try { if (!verifyEvent(del)) continue; } catch { continue; }
    for (const tag of del.tags || []) {
      if (tag[0] === 'e' && typeof tag[1] === 'string') {
        deleted.add(`${del.pubkey}:${tag[1]}`);
      }
    }
  }

  const authorSet = new Set(authors.nostr);
  const seen = new Set();
  const records = [];
  for (const ev of fileEvents) {
    // Defense in depth: relays are supposed to return only what we asked
    // for, but re-check kind, author, and signature.
    if (ev.kind !== 1063) continue;
    if (!authorSet.has(ev.pubkey)) continue;
    if (!HEX64_RE.test(String(ev.id))) continue;
    try { if (!verifyEvent(ev)) continue; } catch { continue; }
    if (deleted.has(`${ev.pubkey}:${ev.id}`)) continue;
    if (seen.has(ev.id)) continue;
    seen.add(ev.id);
    const record = eventToRecord(ev);
    if (record) records.push(record);
  }
  return records;
}

// ── atproto listing ─────────────────────────────────────────────────────────

// entry (handle or DID) → DID, via bsky's public CORS-open appview for
// handles. Failures are dropped (same degradation as a dead PDS).
async function resolveEntryDid(entry) {
  if (entry.startsWith('did:')) return entry;
  try {
    const u = new URL('https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle');
    u.searchParams.set('handle', entry);
    const data = await (await fetch(u)).json();
    return typeof data.did === 'string' && data.did.startsWith('did:') ? data.did : null;
  } catch { return null; }
}

export async function fetchAtprotoRecords(authors) {
  const out = [];
  await Promise.all(authors.atproto.map(async (entry) => {
    const did = await resolveEntryDid(entry);
    if (!did) return;
    const handle = entry.startsWith('did:') ? did : entry;
    const pds = await ln().resolvePds(did);
    if (!pds) return;
    const rows = await ln().listPdsRecords(pds, did, cfg().collection, 50);
    for (const r of rows) {
      const uri = typeof r.uri === 'string' ? r.uri : '';
      const rkey = uri.split('/').pop() || '';
      if (!ATPROTO_RKEY_RE.test(rkey)) continue;
      const value = r.value && typeof r.value === 'object' ? r.value : {};
      out.push({ uri, rkey, did, handle, value });
    }
  }));
  return out;
}

// ── Decoration (client port of lib/linkage.ts decorateRecords) ─────────────
// Fills authorName / authorUrl / groupDid. Linked pairs present as the
// atproto identity on both networks' records; unlinked nostr records fall
// back to the von-scoped name, then the kind-0 profile name, then the
// truncated npub.

export async function decorateRecords(records) {
  if (records.length === 0) return;
  const relays = cfg().relays;
  const pubkeys = [...new Set(
    records.filter((r) => r.did.startsWith('npub1'))
      .map((r) => ln().npubToHex(r.did)).filter(Boolean),
  )];

  let claims = new Map(), vonNames = new Map(), profiles = new Map();
  if (pubkeys.length > 0) {
    [claims, vonNames, profiles] = await Promise.all([
      ln().fetchLinkClaims(relays, pubkeys, cfg().linkCollection).catch(() => new Map()),
      ln().fetchVonNames(relays, pubkeys, cfg().profileDTag).catch(() => new Map()),
      ln().fetchProfiles(relays, pubkeys).catch(() => new Map()),
    ]);
  }

  // Only mutual (PDS points back) claims count as one person.
  const npubToDid = new Map();
  await Promise.all([...claims].map(async ([pubkey, did]) => {
    try {
      if (await ln().isMutualLink(pubkey, did, cfg().linkCollection)) {
        const npub = ln().hexToNpub(pubkey);
        if (npub) npubToDid.set(npub, did);
      }
    } catch { /* one-way / unreachable → per-network display */ }
  }));
  const linkedDids = new Set(npubToDid.values());

  // Resolve each distinct DID's display name once per pass.
  const namePromises = new Map();
  const displayName = (did) => {
    let p = namePromises.get(did);
    if (!p) {
      p = ln().atprotoNameOf(did).catch(() => null);
      namePromises.set(did, p);
    }
    return p;
  };

  await Promise.all(records.map(async (r) => {
    if (r.did.startsWith('npub1')) {
      const did = npubToDid.get(r.did);
      if (did) {
        r.authorName = (await displayName(did)) || `${r.handle.slice(0, 12)}…`;
        r.authorUrl = `https://bsky.app/profile/${did}`;
        r.groupDid = did;
        return;
      }
      const hex = ln().npubToHex(r.did);
      r.authorName = (hex && (vonNames.get(hex) || ln().profileNameOf(profiles.get(hex)))) ||
        `${r.handle.slice(0, 12)}…`;
      r.authorUrl = `https://njump.me/${r.did}`;
      r.groupDid = r.did;
      return;
    }
    r.authorName = linkedDids.has(r.did)
      ? ((await displayName(r.did)) || r.handle)
      : r.handle;
    r.authorUrl = `https://bsky.app/profile/${r.did}`;
    r.groupDid = r.did;
  }));
}

// ── The full listing pipeline ───────────────────────────────────────────────

export async function loadAllRecords() {
  const authors = await getAuthors();
  const [nostr, atproto] = await Promise.all([
    fetchNostrRecords(authors),
    fetchAtprotoRecords(authors),
  ]);
  const visible = [...nostr, ...atproto]
    .filter((r) => recordPassesTagFilter(r.value, authors));
  // Sort by createdAt descending (newest first) — string compare, same as
  // the parent's lib/records.ts.
  visible.sort((a, b) => {
    const ta = String(a.value.createdAt || '');
    const tb = String(b.value.createdAt || '');
    return tb.localeCompare(ta);
  });
  await decorateRecords(visible);
  return { records: visible, authors };
}
