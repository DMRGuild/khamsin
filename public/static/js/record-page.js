// Record detail page: fetches ONE record — from the relays (npub URLs, with
// signature/author/collection verification and the allowlist gate) or from
// the author's PDS (DID URLs) — applies the tag filter, resolves
// window.__vonRecord (created by an early inline script in record.eta), and
// fills the page skeleton. All relay/PDS strings land via textContent.

import {
  ARWEAVE_TXID_RE,
  decorateRecords,
  eventToRecord,
  getAuthors,
  recordPassesTagFilter,
} from './von-data.js';

const HEX64_RE = /^[0-9a-f]{64}$/;
const ATPROTO_RKEY_RE = /^[A-Za-z0-9._~:-]{1,512}$/;
const B64_RE = /^[A-Za-z0-9+/]+=*$/;

const resolveRecord = window.__vonRecordResolve || (() => {});

main().catch(() => {
  resolveRecord(null);
  fail('Could not load the record — the relays or the PDS may be unreachable.');
});

function $(id) {
  return document.getElementById(id);
}

function fail(message) {
  const statusEl = $('record-status');
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.className = 'error';
  }
}

async function main() {
  const m = location.pathname.match(/^\/record\/([^/]+)\/([^/]+)$/);
  if (!m) { resolveRecord(null); return; }
  const did = decodeURIComponent(m[1]);
  const rkey = decodeURIComponent(m[2]);

  const record = did.startsWith('npub1')
    ? await fetchNostrRecord(did, rkey)
    : await fetchAtprotoRecord(did, rkey);

  if (!record) {
    resolveRecord(null);
    fail('Record not found.');
    return;
  }

  const authors = await getAuthors();
  if (!recordPassesTagFilter(record.value, authors)) {
    resolveRecord(null);
    fail('Record not found.');
    return;
  }

  await decorateRecords([record]).catch(() => { /* per-network display */ });
  resolveRecord(record);
  fill(record);
}

// npub path: the event id is the rkey. One retry tolerates the propagation
// lag right after a browser-side publish (mirror of lib/nostr.ts).
async function fetchNostrRecord(npub, idHex) {
  if (!HEX64_RE.test(idHex)) return null;
  const ln = window.vonLn;
  const authors = await getAuthors();
  const allowed = new Set(authors.nostr);
  if (allowed.size === 0) return null;
  const verifyEvent = await ln.verifyEventFn();

  for (let attempt = 0; attempt < 2; attempt++) {
    const events = await ln.relayQuery(window.VON.relays, { ids: [idHex] }, 5000);
    for (const ev of events) {
      if (
        ev.id !== idHex ||
        ev.kind !== 1063 ||
        !allowed.has(ev.pubkey) ||
        ln.hexToNpub(ev.pubkey) !== npub ||
        !(ev.tags || []).some((t) => t[0] === 't' && t[1] === window.VON.collection)
      ) {
        continue;
      }
      try { if (!verifyEvent(ev)) continue; } catch { continue; }
      return eventToRecord(ev);
    }
    // Miss: brief pause, then retry once (publish → view races).
    if (attempt === 0) await new Promise((r) => setTimeout(r, 700));
  }
  return null;
}

async function fetchAtprotoRecord(did, rkey) {
  if (!ATPROTO_RKEY_RE.test(rkey)) return null;
  const ln = window.vonLn;
  const pds = await ln.resolvePds(did);
  if (!pds) return null;
  const data = await ln.getPdsRecordRkey(pds, did, window.VON.collection, rkey);
  if (!data || !data.value || typeof data.value !== 'object') return null;
  return {
    uri: typeof data.uri === 'string' ? data.uri : `at://${did}/${window.VON.collection}/${rkey}`,
    rkey,
    did,
    handle: did,
    value: data.value,
  };
}

function fill(record) {
  $('record-status')?.remove();
  const article = $('record-detail');
  if (!article) return;
  article.hidden = false;

  const v = record.value;
  const title = String(v.title || '') || '(untitled)';
  $('rec-title').textContent = title;
  document.title = `${title} — ${window.VON.siteName}`;

  if (v.description) {
    const d = $('rec-description');
    d.textContent = String(v.description);
    d.hidden = false;
  }

  // Author: replace the server's identifier fallback with the resolved name.
  if (record.authorName) {
    const dd = $('rec-author');
    dd.textContent = '';
    const a = document.createElement('a');
    a.href = record.authorUrl || (record.did.startsWith('npub1')
      ? `https://njump.me/${record.did}`
      : `https://bsky.app/profile/${record.did}`);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = record.handle;
    a.textContent = record.authorName;
    dd.append(a);
    // A linked pair displays the atproto identity on nostr records too; keep
    // the nostr provenance visible (full pointer is in the nevent block).
    if (record.groupDid && record.groupDid !== record.did) {
      const via = document.createElement('span');
      via.className = 'muted';
      via.title = record.did;
      via.textContent = ' via nostr';
      dd.append(via);
    }
  }

  $('rec-created').textContent = String(v.createdAt || '—');
  $('rec-file').textContent = String(v.fileName || '—');

  if (v.cid) {
    // eventToRecord / the regex gates below guarantee URL-safe identifiers.
    const cid = String(v.cid);
    // Pinata first for the same reason as gentou's gateway chain: fresh
    // pins live there before the public gateways discover them.
    $('rec-cid-link').href = `https://gateway.pinata.cloud/ipfs/${cid}`;
    $('rec-cid').textContent = cid;
    $('rec-cid-viewer').href = `https://gentou.nrpl.xyz/?cid=${cid}`;
    $('rec-cid-dt').hidden = false;
    $('rec-cid-dd').hidden = false;
  } else if (typeof v.arweave === 'string' && ARWEAVE_TXID_RE.test(v.arweave)) {
    $('rec-arweave-link').href = `https://arweave.net/${v.arweave}`;
    $('rec-arweave').textContent = v.arweave;
    $('rec-arweave-viewer').href = `https://gentou.nrpl.xyz/?cid=${v.arweave}`;
    $('rec-arweave-dt').hidden = false;
    $('rec-arweave-dd').hidden = false;
  } else {
    // Neither payload: mirror the parent's "CID: —" row.
    $('rec-cid-dd').textContent = '—';
    $('rec-cid-dt').hidden = false;
    $('rec-cid-dd').hidden = false;
  }

  if (Array.isArray(v.artifacts) && v.artifacts.length > 0) {
    const list = $('rec-artifact-list');
    for (const a of v.artifacts) {
      const li = document.createElement('li');
      const code = document.createElement('code');
      code.textContent = String(a);
      li.append(code);
      list.append(li);
    }
    $('rec-artifacts-dt').hidden = false;
    $('rec-artifacts-dd').hidden = false;
  }

  // OTS raw proofs (the verify pipeline itself lives in gentou.eta, which
  // unhides the row when it has something to say).
  const ots = typeof v.ots === 'string' ? v.ots.trim() : '';
  if (ots.length > 20 && B64_RE.test(ots)) {
    $('ots-raw-main').textContent = ots;
  }
  const sigOts = typeof v.sigOts === 'string' ? v.sigOts.trim() : '';
  if (sigOts.length > 20 && B64_RE.test(sigOts)) {
    $('ots-raw-sig').textContent = sigOts;
    $('ots-raw-sig-wrap').hidden = false;
  }

  // Owner actions: nostr deletion (kind 5 via authbar's delegated listener).
  const session = window.__vonSession || null;
  if (
    session && session.npub && record.did === session.npub &&
    record.did.startsWith('npub1')
  ) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-danger nostr-delete';
    btn.style.marginTop = '1rem';
    btn.dataset.eventId = record.rkey;
    // IPFS-backed records: the delete flow also asks the server to drop
    // the Pinata pin (POST /unpin, ownership-verified server-side).
    if (record.value.cid) btn.dataset.cid = String(record.value.cid);
    btn.textContent = 'Delete';
    $('rec-owner-actions').append(btn);
  }
}
