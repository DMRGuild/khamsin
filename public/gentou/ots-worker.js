/**
 * ots-worker.js — OpenTimestamps verification off the main thread.
 *
 * Module Web Worker around ./ots.js. Receives the original file bytes and
 * the .ots proof, hashes the file locally (the proof's digest is never
 * trusted to describe the content — only the bytes in hand are), evaluates
 * the proof's operation tree, and checks every Bitcoin attestation against
 * block headers fetched from several independent Esplora-API explorers.
 * All reachable explorers must agree on the block hash, merkle root and
 * timestamp; any disagreement fails the verification outright.
 *
 * Input message:
 *   {
 *     fileBytes: ArrayBuffer,   // original content bytes (transferred)
 *     otsBytes:  ArrayBuffer,   // raw .ots proof bytes (transferred)
 *     explorers: string[],      // Esplora API bases (two or more), e.g.
 *                               // https://blockstream.info/api
 *   }
 *
 * Output messages:
 *   { type: 'log', msg, cls? }                        — progress lines
 *   { type: 'result', status: 'verified', ... }       — see below
 *   { type: 'result', status: 'pending',  calendars } — not yet anchored
 *   { type: 'result', status: 'mismatch', message }   — file ≠ proof digest
 *   { type: 'result', status: 'error',    message }   — anything else
 */

import * as OTS from './ots.js';

const FETCH_TIMEOUT_MS = 10000;

const log = (msg, cls) => self.postMessage({ type: 'log', msg, cls });

async function fetchWithTimeout(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

/** Block hash + header fields for a height, from one Esplora endpoint. */
async function fetchHeader(base, height) {
  const hash = (await (await fetchWithTimeout(`${base}/block-height/${height}`)).text()).trim();
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error('malformed block hash');
  const block = await (await fetchWithTimeout(`${base}/block/${hash}`)).json();
  if (typeof block.merkle_root !== 'string' || typeof block.timestamp !== 'number') {
    throw new Error('malformed block header');
  }
  return {
    base,
    hash: hash.toLowerCase(),
    merkleRoot: block.merkle_root.toLowerCase(),
    time: block.timestamp,
  };
}

/**
 * Fetch a block header from every explorer and require consensus: at least
 * two must respond (a lone answer can't be cross-checked) and every answer
 * must agree on hash, merkle root and timestamp.
 */
async function crossCheckedHeader(explorers, height) {
  const results = await Promise.allSettled(explorers.map((base) => fetchHeader(base, height)));
  const ok = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      log(`${new URL(explorers[i]).hostname}: block ${height} = ${r.value.hash.slice(0, 16)}…`);
      ok.push(r.value);
    } else {
      log(`${new URL(explorers[i]).hostname}: ${r.reason.message}`, 'err');
    }
  });

  if (ok.length < 2) {
    throw new Error(`only ${ok.length} of ${explorers.length} explorers reachable — cannot cross-check`);
  }
  for (const h of ok.slice(1)) {
    if (h.hash !== ok[0].hash || h.merkleRoot !== ok[0].merkleRoot || h.time !== ok[0].time) {
      throw new Error(`explorers disagree about block ${height} (${ok[0].base} vs ${h.base})`);
    }
  }
  return { header: ok[0], sources: ok.map((h) => h.base) };
}

/**
 * Try to complete pending attestations by querying their calendar servers,
 * the same live "upgrade" the opentimestamps.org verifier performs: a stamp
 * created moments after `ots stamp` only references calendars, and the
 * Bitcoin-anchored continuation stays on the calendar unless someone runs
 * `ots upgrade`. The record stores the upload-time stamp, so this path is
 * the norm, not the exception.
 *
 * The continuation extends the proof from the pending attestation's own
 * commitment message, so the local digest→commitment chain stays intact;
 * a lying calendar still can't survive the block-header cross-check below.
 *
 * @returns Bitcoin-attestation entries found across all calendars.
 */
const MAX_UPGRADE_BYTES = 65536;

async function upgradeFromCalendars(pending) {
  const results = await Promise.allSettled(pending.map(async (att) => {
    let uri;
    try { uri = new URL(att.uri); } catch { throw new Error(`calendar URI unparsable`); }
    if (uri.protocol !== 'https:') throw new Error(`calendar ${uri.hostname}: not https`);
    const commitment = OTS.bytesToHex(att.msg);
    const res = await fetchWithTimeout(`${uri.origin}${uri.pathname.replace(/\/$/, '')}/timestamp/${commitment}`);
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.length > MAX_UPGRADE_BYTES) throw new Error(`calendar ${uri.hostname}: oversized response`);
    const root = OTS.parseUpgrade(body);
    const { attestations } = await OTS.evaluate({ fileDigest: att.msg, root });
    return { hostname: uri.hostname, attestations };
  }));

  const bitcoin = [];
  results.forEach((r, i) => {
    const host = (() => { try { return new URL(pending[i].uri).hostname; } catch { return pending[i].uri; } })();
    if (r.status === 'rejected') {
      log(`${host}: ${r.reason.message}`, 'dim');
      return;
    }
    const found = r.value.attestations.filter((a) => a.type === 'bitcoin');
    log(`${host}: ${found.length ? `anchored at block ${found.map((a) => a.height).join(', ')}` : 'still pending'}`);
    for (const a of found) {
      if (!bitcoin.some((b) => b.height === a.height && b.expectedMerkleRoot === a.expectedMerkleRoot)) {
        bitcoin.push(a);
      }
    }
  });
  return bitcoin;
}

/**
 * Confirm the proof's embedded-transaction hint against the explorers.
 * Display-only: on any doubt the txid is dropped, never the verification.
 */
async function confirmTxid(explorers, txid, height, blockHash) {
  const results = await Promise.allSettled(
    explorers.map(async (base) => (await fetchWithTimeout(`${base}/tx/${txid}`)).json()),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (ok.length < 2) return null;
  const confirmed = ok.every((tx) =>
    tx?.status?.confirmed === true &&
    tx.status.block_height === height &&
    String(tx.status.block_hash).toLowerCase() === blockHash
  );
  return confirmed ? txid : null;
}

self.onmessage = async (e) => {
  const { fileBytes, otsBytes, explorers } = e.data;
  try {
    // 1. Parse the proof and hash the actual content bytes locally.
    const proof = OTS.parse(new Uint8Array(otsBytes));
    log(`proof parsed (file hash: ${proof.fileHashOp})`);
    const digest = await OTS.hashFile(new Uint8Array(fileBytes), proof.fileHashOp);
    log(`local ${proof.fileHashOp}: ${OTS.bytesToHex(digest)}`);

    if (!OTS.bytesEqual(digest, proof.fileDigest)) {
      self.postMessage({
        type: 'result',
        status: 'mismatch',
        message: 'content does not match the timestamped file',
        localDigest: OTS.bytesToHex(digest),
        proofDigest: OTS.bytesToHex(proof.fileDigest),
      });
      return;
    }

    // 2. Run the commitment operations.
    const { attestations, errors } = await OTS.evaluate(proof);
    for (const err of errors) log(`skipped branch: ${err}`, 'dim');

    let bitcoin = attestations.filter((a) => a.type === 'bitcoin');
    let upgraded = false;
    if (bitcoin.length === 0) {
      const pending = attestations.filter((a) => a.type === 'pending');
      if (pending.length === 0) {
        self.postMessage({
          type: 'result',
          status: 'error',
          message: 'proof contains no verifiable Bitcoin attestation',
        });
        return;
      }
      // The stamp itself is calendar-only — ask the calendars for the
      // Bitcoin-anchored continuation before declaring it pending.
      log(`no Bitcoin attestation in the stamp — querying ${pending.length} calendar(s)...`);
      bitcoin = await upgradeFromCalendars(pending);
      upgraded = bitcoin.length > 0;
      if (!upgraded) {
        self.postMessage({ type: 'result', status: 'pending', calendars: pending.map((a) => a.uri) });
        return;
      }
    }

    // 3. Check every Bitcoin attestation against cross-checked headers.
    //    One tampered attestation fails the whole proof.
    const verified = [];
    for (const att of bitcoin) {
      log(`verifying Bitcoin attestation at block ${att.height}...`);
      const { header, sources } = await crossCheckedHeader(explorers, att.height);
      const time = OTS.verifyAgainstHeader(att, header); // throws on merkle mismatch
      verified.push({ att, header, sources, time });
      log(`merkle root matches block ${att.height}`, 'ok');
    }

    // 4. Report the earliest attestation as the proof-of-existence time.
    verified.sort((a, b) => a.time - b.time);
    const best = verified[0];
    const txid = best.att.txid
      ? await confirmTxid(explorers, best.att.txid, best.att.height, best.header.hash)
      : null;

    self.postMessage({
      type: 'result',
      status: 'verified',
      height: best.att.height,
      blockHash: best.header.hash,
      merkleRoot: best.header.merkleRoot,
      time: best.time,
      txid,
      sources: best.sources,
      upgraded,
      digest: OTS.bytesToHex(digest),
      attestationCount: bitcoin.length,
    });
  } catch (err) {
    self.postMessage({ type: 'result', status: 'error', message: err.message });
  }
};
