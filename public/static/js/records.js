// Client-side sidebar renderer: fetches the document listing (relays +
// PDSes via von-data.js) and emits rows with the EXACT DOM contract of
// views/partials/record.eta — blackboard's sidebar subgrid (author | title |
// year columns) depends on it, including an empty span.record-author when a
// grouped row suppresses the author cell. All strings from relays/PDSes are
// inserted via textContent.

import { loadAllRecords } from './von-data.js';

// ── Listing cache (localStorage) ────────────────────────────────────────────
// Only the FIRST visit shows the distributed-fetch loader; afterwards the
// cached list paints immediately and a quiet background refresh swaps in the
// fresh listing (new records appear, deleted ones vanish) a few seconds
// later. Cached rows were signature-verified when first fetched; still,
// localStorage is user-writable, so entries are shape-checked before any of
// them can reach an href, and all text lands via textContent as usual.

const CACHE_KEY = 'von-records-cache-v1';
const CACHE_MAX_RECORDS = 500;

const NPUB_RE = /^npub1[a-z0-9]{20,90}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ATPROTO_DID_RE = /^did:[a-z]+:[a-zA-Z0-9._%:-]{1,250}$/;
const ATPROTO_RKEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/;
const AUTHOR_URL_RE = /^https:\/\/(njump\.me|bsky\.app)\//;

function saneCachedRecord(r) {
  if (!r || typeof r !== 'object' || !r.value || typeof r.value !== 'object') {
    return false;
  }
  if (typeof r.did !== 'string' || typeof r.rkey !== 'string') return false;
  const idsOk = NPUB_RE.test(r.did)
    ? HEX64_RE.test(r.rkey)
    : ATPROTO_DID_RE.test(r.did) && ATPROTO_RKEY_RE.test(r.rkey);
  if (!idsOk) return false;
  // Only vetted hosts may come back out of the cache as an href.
  if (r.authorUrl !== undefined &&
      (typeof r.authorUrl !== 'string' || !AUTHOR_URL_RE.test(r.authorUrl))) {
    delete r.authorUrl;
  }
  if (r.groupDid !== undefined && typeof r.groupDid !== 'string') {
    delete r.groupDid;
  }
  return true;
}

function readCache() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!raw || !Array.isArray(raw.records)) return null;
    return raw.records.filter(saneCachedRecord);
  } catch {
    return null;
  }
}

function writeCache(records) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      at: Date.now(),
      records: records.slice(0, CACHE_MAX_RECORDS),
    }));
  } catch { /* storage full or blocked — cache is a convenience */ }
}

/** Removes every row records.js has rendered (fresh re-render follows). */
function clearRows(aside) {
  aside.querySelectorAll('article.record, [data-von-note]').forEach((el) => el.remove());
}

function emptyNote(aside) {
  const p = document.createElement('p');
  p.className = 'muted';
  p.dataset.vonNote = '';
  p.textContent = 'No documents yet.';
  aside.append(p);
}

async function main(aside) {
  const statusEl = document.getElementById('doc-list-status');

  const cached = readCache();
  if (cached && cached.length > 0) {
    // Return visit: paint the cache instantly, no loader, then refresh
    // quietly. The fresh listing replaces the rows wholesale so additions,
    // deletions, and renamed authors all land in one silent swap.
    statusEl?.remove();
    renderList(aside, cached);
    try {
      const { records } = await loadAllRecords();
      // An empty refresh against a non-empty cache is far more likely a
      // relay/PDS outage than a genuinely emptied archive — keep the cached
      // view and the cache rather than quietly wiping both. (A truly
      // emptied archive corrects itself once a load succeeds from cold.)
      if (records.length > 0) {
        writeCache(records);
        clearRows(aside);
        renderList(aside, records);
      }
    } catch { /* refresh failed — the cached view stands */ }
    zapBadges().catch(() => { /* badges are decoration */ });
    return;
  }

  // First visit (or unusable cache): the loader runs until the full load
  // finishes.
  let records;
  try {
    ({ records } = await loadAllRecords());
  } catch {
    if (statusEl) {
      // Swap the loader for a plain status line (clearing children drops
      // the animation markup; the class swap drops its layout).
      statusEl.className = 'muted';
      statusEl.textContent = 'Could not load the document list — the relays may be unreachable.';
    }
    return;
  }

  statusEl?.remove();
  writeCache(records);
  if (records.length === 0) {
    emptyNote(aside);
    return;
  }

  renderList(aside, records);
  zapBadges().catch(() => { /* badges are decoration */ });
}

function renderList(aside, records) {
  // Stable group-by author: the feed arrives newest-first, so authors are
  // interleaved. Collect each author's records into one contiguous block
  // while preserving first-seen order, then flatten. Grouping uses the
  // canonical key (groupDid), so a verified atproto↔nostr pair reads as one
  // author; ownership checks still use the record's own did.
  const keyOf = (r) => r.groupDid || r.did;
  const groups = new Map();
  for (const r of records) {
    if (!groups.has(keyOf(r))) groups.set(keyOf(r), []);
    groups.get(keyOf(r)).push(r);
  }
  const ordered = [...groups.values()].flat();

  const currentDid = aside.dataset.currentDid || null;
  const currentRkey = aside.dataset.currentRkey || null;
  const session = window.__vonSession || null;

  const frag = document.createDocumentFragment();
  ordered.forEach((r, i) => {
    const hideAuthor = i > 0 && keyOf(ordered[i - 1]) === keyOf(r);

    const article = document.createElement('article');
    article.className = 'record';

    // Author cell — MUST exist even when empty (subgrid column).
    const author = document.createElement('span');
    author.className = 'record-author';
    if (!hideAuthor) {
      const a = document.createElement('a');
      a.href = r.authorUrl || (r.did.startsWith('npub1')
        ? `https://njump.me/${r.did}`
        : `https://bsky.app/profile/${r.did}`);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = r.handle;
      a.textContent = r.authorName || r.handle;
      author.append(a);
    }
    article.append(author);

    const heading = document.createElement('h3');
    heading.className = 'record-heading';
    const link = document.createElement('a');
    link.className = 'record-title-link';
    link.href = `/record/${r.did}/${r.rkey}`;
    if (currentDid && currentRkey && r.did === currentDid && r.rkey === currentRkey) {
      link.setAttribute('aria-current', 'page');
    }
    link.textContent = r.value.title || '(untitled)';
    heading.append(link);
    article.append(heading);

    const time = document.createElement('time');
    time.className = 'record-date';
    time.dateTime = String(r.value.createdAt || '');
    time.textContent = (String(r.value.createdAt || '').match(/\d{4}/) || ['—'])[0];
    article.append(time);

    // Nostr deletion (kind 5, handled by authbar's delegated listener).
    if (session && session.npub && r.did === session.npub && r.did.startsWith('npub1')) {
      const wrap = document.createElement('span');
      wrap.className = 'inline-form record-delete';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-danger nostr-delete';
      btn.dataset.eventId = r.rkey;
      // IPFS-backed records: the delete flow also asks the server to drop
      // the Pinata pin (POST /unpin, ownership-verified server-side).
      if (r.value.cid) btn.dataset.cid = r.value.cid;
      btn.textContent = 'Delete';
      wrap.append(btn);
      article.append(wrap);
    }

    frag.append(article);
  });
  aside.append(frag);
}

// Zap-total badges for nostr-backed documents, one batched relay query.
// Receipts are signature-checked but the signer is not matched against each
// author's LNURL key (that stricter check runs on the record page, where a
// single provider lookup suffices) — hence "as reported by relays".
async function zapBadges() {
  // Deployment display switch (DISABLE_ZAPS) — covers both call sites.
  if (window.VON.zapsDisabled) return;
  const RELAYS = window.VON.relays || [];
  const links = document.querySelectorAll('.doc-sidebar .record-title-link');
  const byId = new Map();
  for (const a of links) {
    const m = (a.getAttribute('href') || '')
      .match(/^\/record\/npub1[a-z0-9]+\/([0-9a-f]{64})$/);
    if (m) byId.set(m[1], a);
  }
  if (byId.size === 0 || RELAYS.length === 0 || !window.vonLn) return;
  const receipts = await window.vonLn.fetchZapReceipts(RELAYS, { eventIds: [...byId.keys()] });
  const verified = await window.vonLn.verifyZapReceipts(receipts);
  const totals = new Map();
  for (const { event, msat } of verified) {
    for (const t of event.tags) {
      if (t[0] === 'e' && byId.has(t[1])) {
        totals.set(t[1], (totals.get(t[1]) || 0) + msat);
      }
    }
  }
  for (const [id, msat] of totals) {
    const sats = Math.floor(msat / 1000);
    if (sats < 1) continue;
    const badge = document.createElement('span');
    badge.className = 'zap-badge';
    badge.title = `${sats.toLocaleString('en-US')} sats zapped (as reported by relays)`;
    badge.textContent = `⚡${sats >= 1000 ? `${(sats / 1000).toFixed(sats >= 10000 ? 0 : 1)}k` : sats}`;
    byId.get(id).after(badge);
  }
}

// Kick off after every declaration above (module consts are TDZ-scoped —
// calling main() from the top of the file would throw inside readCache).
const aside = document.querySelector('.doc-sidebar');
if (aside) main(aside);
