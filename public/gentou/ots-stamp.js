/**
 * ots-stamp.js — browser-side OpenTimestamps stamping.
 *
 * Zero-dependency ES module (fflate is dynamically imported only for archive
 * uploads, the same way the gentou viewer does). Creates a detached .ots
 * proof for an upload before it is published:
 *
 *   1. Picks the document to stamp. For archives (.zip/.tar.gz/.tgz) that is
 *      the main document inside, chosen with the same heuristic and the same
 *      single-top-level-directory unwrap as the server's IPFS pipeline — the
 *      server re-derives the pick and rejects the upload if the proof doesn't
 *      commit to it. If the archive also carries a GPG-family detached
 *      signature (.sig/.asc/…), that file gets its own proof the same way.
 *   2. Hashes it with WebCrypto SHA-256, appends a random 16-byte nonce and
 *      hashes again — the nonce keeps the file digest private from the
 *      calendar servers (standard OpenTimestamps client behavior).
 *   3. Submits the blinded digest to the configured calendar servers
 *      (POST <calendar>/digest) and merges their timestamp trees.
 *   4. Serializes everything into the .ots binary format (the mirror of
 *      ots.js's parser) and self-checks the result by re-parsing it.
 *
 * The resulting proof carries `pending` (calendar) attestations; the Bitcoin
 * anchor appears on the calendars hours later, and the viewer's verifier
 * (gentou/ots-worker.js) upgrades pending proofs live when verifying.
 *
 * License: GPLv3 (same as the enclosing project).
 */

import * as OTS from './ots.js';

// ── serialization (mirror of ots.js's parser) ────────────────────────

const TAG_ATTESTATION = 0x00;
const TAG_FORK = 0xff;
const OP_TAG_BY_TYPE = {
  sha1: 0x02,
  ripemd160: 0x03,
  sha256: 0x08,
  keccak256: 0x67,
  append: 0xf0,
  prepend: 0xf1,
  reverse: 0xf2,
  hexlify: 0xf3,
};
const ATTESTATION_TAG_BY_TYPE = {
  bitcoin: '0588960d73d71901',
  litecoin: '06869a0d73d71b45',
  ethereum: '30fe8087b5c7ead7',
  pending: '83dfe30d2ef90c8e',
};

class ByteWriter {
  constructor() {
    this.chunks = [];
  }
  byte(b) {
    this.chunks.push(Uint8Array.of(b));
  }
  bytes(arr) {
    this.chunks.push(arr instanceof Uint8Array ? arr : Uint8Array.from(arr));
  }
  varuint(value) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('varuint out of range');
    }
    const out = [];
    do {
      let b = value % 128;
      value = Math.floor(value / 128);
      if (value > 0) b |= 0x80;
      out.push(b);
    } while (value > 0);
    this.bytes(out);
  }
  varbytes(arr) {
    this.varuint(arr.length);
    this.bytes(arr);
  }
  result() {
    let len = 0;
    for (const c of this.chunks) len += c.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

function writeAttestation(w, att) {
  const tagHex = ATTESTATION_TAG_BY_TYPE[att.type];
  if (!tagHex) throw new Error(`cannot serialize attestation: ${att.type}`);
  w.byte(TAG_ATTESTATION);
  w.bytes(tagHex.match(/../g).map((h) => parseInt(h, 16)));
  const payload = new ByteWriter();
  if (att.type === 'pending') {
    payload.varbytes(new TextEncoder().encode(att.uri));
  } else {
    payload.varuint(att.height);
  }
  w.varbytes(payload.result());
}

function writeOpEdge(w, op, child) {
  const tag = OP_TAG_BY_TYPE[op.type];
  if (!tag) throw new Error(`cannot serialize op: ${op.type}`);
  w.byte(tag);
  if (op.type === 'append' || op.type === 'prepend') w.varbytes(op.arg);
  writeTree(w, child);
}

/** Serializes a timestamp tree node (ops + attestations, 0xff-forked). */
function writeTree(w, node) {
  const edges = [
    ...node.attestations.map((att) => () => writeAttestation(w, att)),
    ...node.ops.map(([op, child]) => () => writeOpEdge(w, op, child)),
  ];
  if (edges.length === 0) throw new Error('cannot serialize empty tree node');
  edges.forEach((write, i) => {
    if (i < edges.length - 1) w.byte(TAG_FORK);
    write();
  });
}

/** Serializes a complete detached .ots proof (sha256 file hash only). */
export function serializeProof(fileDigest, root) {
  const w = new ByteWriter();
  w.bytes(OTS.HEADER_MAGIC);
  w.varuint(1); // major version
  w.byte(OP_TAG_BY_TYPE.sha256);
  w.bytes(fileDigest);
  writeTree(w, root);
  return w.result();
}

// ── calendar submission ──────────────────────────────────────────────

const CALENDAR_TIMEOUT_MS = 15000;
const MAX_CALENDAR_RESPONSE = 64 * 1024;

async function submitToCalendar(calendar, digest) {
  const res = await fetch(`${calendar.replace(/\/$/, '')}/digest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/vnd.opentimestamps.v1',
    },
    body: digest,
    signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`calendar ${calendar}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_CALENDAR_RESPONSE) {
    throw new Error(`calendar ${calendar}: bad response size`);
  }
  // Throws if the response isn't a valid timestamp tree.
  return OTS.parseUpgrade(bytes);
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Stamps a payload digest with the given calendars.
 *
 * @param {Uint8Array} fileDigest - SHA-256 of the payload.
 * @param {string[]} calendars - Calendar base URLs.
 * @param {(msg: string) => void} [onStatus] - Progress callback.
 * @returns {Promise<Uint8Array>} Serialized .ots proof bytes.
 */
export async function stampDigest(fileDigest, calendars, onStatus = () => {}) {
  // Blind the digest: fileDigest --append(nonce)--> --sha256--> submitted.
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const blinded = new Uint8Array(fileDigest.length + nonce.length);
  blinded.set(fileDigest, 0);
  blinded.set(nonce, fileDigest.length);
  const submitted = await sha256(blinded);

  const results = await Promise.allSettled(
    calendars.map((cal) => submitToCalendar(cal, submitted)),
  );
  const trees = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      trees.push(r.value);
      onStatus(`calendar ok: ${new URL(calendars[i]).hostname}`);
    } else {
      onStatus(`calendar failed: ${new URL(calendars[i]).hostname}`);
    }
  });
  if (trees.length === 0) {
    throw new Error('no OpenTimestamps calendar accepted the digest');
  }

  // Merge calendar trees as siblings under the blinding ops.
  const merged = {
    ops: trees.flatMap((t) => t.ops),
    attestations: trees.flatMap((t) => t.attestations),
  };
  const root = {
    ops: [[
      { type: 'append', arg: nonce },
      { ops: [[{ type: 'sha256' }, merged]], attestations: [] },
    ]],
    attestations: [],
  };
  const proof = serializeProof(fileDigest, root);

  // Self-check: the serialized proof must round-trip through the parser and
  // still commit to the file digest with a live attestation.
  const parsed = OTS.parse(proof);
  if (
    parsed.fileHashOp !== 'sha256' ||
    !OTS.bytesEqual(parsed.fileDigest, fileDigest)
  ) {
    throw new Error('internal error: serialized proof failed self-check');
  }
  const { attestations } = await OTS.evaluate(parsed);
  if (!attestations.some((a) => a.type === 'pending' || a.type === 'bitcoin')) {
    throw new Error('internal error: serialized proof has no attestation');
  }
  return proof;
}

// ── archive handling (mirrors the server's IPFS pipeline) ────────────

// Same list and order as the server's SUMMARIZABLE_EXTENSIONS /
// pickMainArtifact — both sides sort the entry list and pick the first match
// per extension, so browser and server always agree on the stamped document.
const MAIN_DOC_EXTENSIONS = [
  '.pdf', '.org', '.md', '.markdown', '.mkd', '.mdown', '.mdwn',
  '.typ', '.tex', '.latex', '.rst', '.textile', '.wiki', '.mediawiki',
  '.muse', '.html', '.htm', '.txt',
];

export function pickMainDocument(names) {
  const sorted = [...names].sort();
  for (const ext of MAIN_DOC_EXTENSIONS) {
    const match = sorted.find((n) => n.toLowerCase().endsWith(ext));
    if (match) return match;
  }
  return null;
}

// GPG-family detached-signature extensions, in pick order. Mirrored by the
// server's pickSignatureArtifact (lib/upload.ts) — like the main document,
// both sides must agree on the picked file, since the server re-derives the
// pick and requires the signature proof to commit to its exact bytes.
const SIG_EXTENSIONS = ['.sig', '.asc', '.sign', '.pgp', '.gpg'];

export function pickSignatureFile(names, mainDoc) {
  const sorted = [...names].sort();
  // A signature named after the main document beats any other candidate.
  for (const ext of SIG_EXTENSIONS) {
    const exact = mainDoc &&
      sorted.find((n) => n.toLowerCase() === (mainDoc + ext).toLowerCase());
    if (exact) return exact;
  }
  for (const ext of SIG_EXTENSIONS) {
    const match = sorted.find((n) => n.toLowerCase().endsWith(ext));
    if (match) return match;
  }
  return null;
}

const isZipMagic = (b) =>
  b.length > 3 && b[0] === 0x50 && b[1] === 0x4b &&
  (b[2] === 3 || b[2] === 5 || b[2] === 7);
const isGzipMagic = (b) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

// Mirror of the server-side archive limits (security_helpers.ts).
const ARC_LIMITS = {
  maxEntries: 1000,
  maxTotal: 256 * 1024 * 1024,
  maxEntry: 64 * 1024 * 1024,
};

// Minimal ustar reader: 512-byte headers, octal size, regular files only.
// (Same approach as the gentou viewer's in-browser extraction.)
function parseTar(tar, files, limits) {
  const dec = new TextDecoder();
  const str = (from, to) => dec.decode(tar.subarray(from, to)).replace(/\0[\s\S]*$/, '');
  let off = 0, count = 0;
  while (off + 512 <= tar.length) {
    const block = tar.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break; // end-of-archive marker
    let name = str(off, off + 100);
    const prefix = str(off + 345, off + 500); // POSIX ustar long-path prefix
    if (prefix) name = prefix + '/' + name;
    const size = parseInt(str(off + 124, off + 136).trim(), 8) || 0;
    const type = tar[off + 156];
    off += 512;
    if ((type === 0x30 || type === 0) && name) { // '0' or NUL → regular file
      if (++count > limits.maxEntries) throw new Error('archive: too many entries');
      if (size > limits.maxEntry) throw new Error(`archive: entry too large (${name})`);
      files.set(name, tar.slice(off, Math.min(off + size, tar.length)));
    }
    off += Math.ceil(size / 512) * 512;
  }
}

async function extractArchive(rawBytes, name) {
  const fflate = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js');
  const files = new Map(); // relPath -> Uint8Array
  if (isZipMagic(rawBytes)) {
    let count = 0, total = 0;
    const out = fflate.unzipSync(rawBytes, {
      filter(f) {
        if (f.name.endsWith('/')) return false;
        if (++count > ARC_LIMITS.maxEntries) throw new Error('archive: too many entries');
        if (f.originalSize > ARC_LIMITS.maxEntry) throw new Error(`archive: entry too large (${f.name})`);
        total += f.originalSize;
        if (total > ARC_LIMITS.maxTotal) throw new Error('archive: uncompressed size limit exceeded');
        return true;
      },
    });
    for (const [n, bytes] of Object.entries(out)) files.set(n, bytes);
  } else if (isGzipMagic(rawBytes)) {
    const chunks = [];
    let total = 0;
    const gz = new fflate.Gunzip((chunk) => {
      total += chunk.length;
      if (total > ARC_LIMITS.maxTotal) throw new Error('archive: uncompressed size limit exceeded');
      chunks.push(chunk);
    });
    gz.push(rawBytes, true);
    const tar = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { tar.set(c, o); o += c.length; }
    parseTar(tar, files, ARC_LIMITS);
  } else {
    throw new Error(`${name}: not a recognized archive (zip or tar.gz)`);
  }
  if (files.size === 0) throw new Error(`${name}: archive contains no files`);
  // Mirror the server's single-top-level-directory unwrap so entry names
  // match what the IPFS pipeline produces.
  const names = [...files.keys()];
  const tops = new Set(names.map((n) => n.split('/')[0]));
  if (tops.size === 1 && names.every((n) => n.includes('/'))) {
    const p = [...tops][0].length + 1;
    return new Map(names.map((n) => [n.slice(p), files.get(n)]));
  }
  return files;
}

// ── top-level API ────────────────────────────────────────────────────

const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function toBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Stamps an upload with OpenTimestamps, entirely in the browser.
 *
 * @param {File} file - The file the user selected.
 * @param {string[]} calendars - Calendar base URLs (from server config).
 * @param {(msg: string) => void} [onStatus] - Progress callback.
 * @returns {Promise<{otsB64: string, sha256Hex: string, stampedName: string,
 *   sigOtsB64: string|null, sigName: string|null}>}
 *   `otsB64` is the base64 proof for the record's `ots` field, `sha256Hex`
 *   the digest of the stamped payload (the NIP-94 `x` tag), `stampedName`
 *   the name of the document the proof commits to. For archives that carry a
 *   GPG-family detached signature, `sigOtsB64`/`sigName` are the proof and
 *   name of that signature file (both null otherwise).
 */
export async function stampFile(file, calendars, onStatus = () => {}) {
  const lower = file.name.toLowerCase();
  let payload;
  let stampedName = file.name;
  let sigPayload = null;
  let sigName = null;

  if (lower.endsWith('.zip') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    onStatus('extracting archive to find the main document...');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = await extractArchive(bytes, file.name);
    const mainDoc = pickMainDocument([...entries.keys()]);
    if (!mainDoc) {
      throw new Error('no main document found in the archive to timestamp');
    }
    payload = entries.get(mainDoc);
    stampedName = mainDoc;
    sigName = pickSignatureFile([...entries.keys()], mainDoc);
    if (sigName) sigPayload = entries.get(sigName);
  } else {
    payload = new Uint8Array(await file.arrayBuffer());
  }

  onStatus(`hashing ${stampedName}...`);
  const digest = await sha256(payload);
  onStatus('submitting to OpenTimestamps calendars...');
  const proof = await stampDigest(digest, calendars, onStatus);

  let sigOtsB64 = null;
  if (sigPayload) {
    onStatus(`hashing signature ${sigName}...`);
    const sigDigest = await sha256(sigPayload);
    onStatus('submitting signature digest to OpenTimestamps calendars...');
    sigOtsB64 = toBase64(await stampDigest(sigDigest, calendars, onStatus));
  }

  return {
    otsB64: toBase64(proof),
    sha256Hex: hex(digest),
    stampedName,
    sigOtsB64,
    sigName,
  };
}
