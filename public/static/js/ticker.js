// Client-side ticker tape: the newest collection-tagged kind-1063 events
// across the configured relays, regardless of author — the "whole market"
// view. Replaces the parent's server-side jetstream/relay watcher (a
// stateless Worker can't hold WebSockets); the atproto (jetstream) source is
// gone, so the tape shows nostr records only. Renders the exact
// .ticker-group ×2 markup the parent layout produced; stays hidden with
// zero items.

import { eventToRecord, getAuthors } from './von-data.js';

const TICKER_COUNT = 20;
const tape = document.getElementById('ticker-tape');
const track = document.getElementById('ticker-track');
if (tape && track) main().catch(() => { /* tape stays hidden */ });

async function main() {
  const ln = window.vonLn;
  const relays = window.VON.relays || [];
  if (!ln || relays.length === 0) return;

  const [events, authors] = await Promise.all([
    ln.relayQuery(relays, {
      kinds: [1063],
      '#t': [window.VON.collection],
      limit: TICKER_COUNT,
    }, 5000),
    getAuthors().catch(() => ({ nostr: [] })),
  ]);

  const verifyEvent = await ln.verifyEventFn();
  const allowed = new Set(authors.nostr || []);
  const items = [];
  for (const ev of events.sort((a, b) => b.created_at - a.created_at)) {
    if (ev.kind !== 1063) continue;
    try { if (!verifyEvent(ev)) continue; } catch { continue; }
    const record = eventToRecord(ev);
    if (!record) continue;
    // Allowlisted authors get a local record page (the detail route is
    // allowlist-scoped); foreign ones link out to njump instead.
    const item = allowed.has(ev.pubkey)
      ? { title: record.value.title, href: `/record/${record.did}/${record.rkey}`, external: false }
      : { title: record.value.title, href: `https://njump.me/${ln.noteEncode(ev.id) || ev.id}`, external: true };
    items.push(item);
    if (items.length >= TICKER_COUNT) break;
  }
  if (items.length === 0) return;

  track.style.animationDuration = `${Math.max(items.length * 5, 30)}s`;
  for (const copy of [0, 1]) {
    const group = document.createElement('div');
    group.className = 'ticker-group';
    if (copy === 1) group.setAttribute('aria-hidden', 'true');
    items.forEach((item, i) => {
      const a = document.createElement('a');
      a.className = 'ticker-item';
      a.href = item.href;
      if (item.external) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      if (copy === 1) a.tabIndex = -1;
      const sym = document.createElement('span');
      sym.className = `ticker-symbol ${i % 2 === 0 ? 'ticker-up' : 'ticker-down'}`;
      sym.textContent = i % 2 === 0 ? '▲' : '▼';
      const title = document.createElement('span');
      title.className = 'ticker-title';
      title.textContent = item.title || '(untitled)';
      a.append(sym, title);
      group.append(a);
    });
    track.append(group);
  }
  tape.hidden = false;
}
