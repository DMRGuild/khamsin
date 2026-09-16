/**
 * ots.js — a standalone OpenTimestamps proof parser and verifier.
 *
 * Zero-dependency ES module. Parses the detached-timestamp (.ots) binary
 * format (magic header + varints + operation tree + attestations), executes
 * the commitment operations with WebCrypto (SHA-256 / SHA-1; RIPEMD-160 in
 * pure JS), and exposes the resulting Bitcoin attestations so a caller can
 * check them against independently fetched block headers.
 *
 * This is an independent implementation of the OpenTimestamps serialization
 * format (https://opentimestamps.org); no code is derived from the reference
 * clients. It deliberately does NOT talk to the network: completeness,
 * calendar upgrades and block-header lookups are the caller's concern, which
 * keeps the trust decisions (which explorers, how many must agree) out of
 * the parser.
 *
 * License: GPLv3 (same as the enclosing project).
 *
 * Typical use:
 *
 *   const proof = OTS.parse(otsBytes);                  // structure only
 *   const digest = await OTS.hashFile(fileBytes, proof.fileHashOp);
 *   if (!OTS.bytesEqual(digest, proof.fileDigest)) ...  // wrong file
 *   const { attestations } = await OTS.evaluate(proof); // run the op tree
 *   // attestations[i].type === 'bitcoin' → fetch block header for
 *   // attestations[i].height yourself, then:
 *   OTS.verifyAgainstHeader(attestations[i], { merkleRoot, time });
 */

// ── binary format constants ──────────────────────────────────────────

/** 31-byte magic at the start of every .ots file:
 *  \x00 "OpenTimestamps" \x00 \x00 "Proof" \x00 \xbf\x89\xe2\xe8\x84\xe8\x92\x94 */
export const HEADER_MAGIC = Uint8Array.from([
  0x00, 0x4f, 0x70, 0x65, 0x6e, 0x54, 0x69, 0x6d, 0x65, 0x73, 0x74,
  0x61, 0x6d, 0x70, 0x73, 0x00, 0x00, 0x50, 0x72, 0x6f, 0x6f, 0x66,
  0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);

const MAJOR_VERSION = 1;

// Operation tags (crypto op tag numbers follow RFC 4880).
const TAG_ATTESTATION = 0x00;
const TAG_FORK = 0xff;
const OP_TAGS = {
  0x02: 'sha1',
  0x03: 'ripemd160',
  0x08: 'sha256',
  0x67: 'keccak256',
  0xf0: 'append',
  0xf1: 'prepend',
  0xf2: 'reverse',
  0xf3: 'hexlify',
};

const DIGEST_LENGTH = { sha1: 20, ripemd160: 20, sha256: 32, keccak256: 32 };

// 8-byte attestation tags, as lowercase hex keys.
const ATTESTATION_TAGS = {
  '0588960d73d71901': 'bitcoin',
  '06869a0d73d71b45': 'litecoin',
  '30fe8087b5c7ead7': 'ethereum',
  '83dfe30d2ef90c8e': 'pending',
};

// Sanity limits, matching the reference clients: they bound the memory a
// hostile proof can make a verifier allocate.
const MAX_OP_ARG_LENGTH = 4096; // Op._MAX_RESULT_LENGTH
const MAX_MSG_LENGTH = 4096; // Op._MAX_MSG_LENGTH
const MAX_ATTESTATION_PAYLOAD = 8192;
const MAX_URI_LENGTH = 1000;
const MAX_TREE_DEPTH = 1000;

export class OtsError extends Error {}
export class OtsParseError extends OtsError {}

// ── small utilities ──────────────────────────────────────────────────

export function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function reversed(bytes) {
  return Uint8Array.from(bytes).reverse();
}

// ── deserialization stream ───────────────────────────────────────────

class Stream {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  read(n) {
    if (this.pos + n > this.bytes.length) {
      throw new OtsParseError('unexpected end of proof');
    }
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readByte() {
    return this.read(1)[0];
  }

  /** Unsigned LEB128, capped so a hostile proof can't overflow Number. */
  readVaruint() {
    let value = 0;
    let shift = 0;
    let b;
    do {
      b = this.readByte();
      if (shift > 46) throw new OtsParseError('varuint too large');
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return value;
  }

  readVarbytes(maxLen, minLen = 0) {
    const l = this.readVaruint();
    if (l > maxLen) throw new OtsParseError(`varbytes too long (${l} > ${maxLen})`);
    if (l < minLen) throw new OtsParseError(`varbytes too short (${l} < ${minLen})`);
    return this.read(l);
  }

  atEof() {
    return this.pos >= this.bytes.length;
  }
}

// ── parsing ──────────────────────────────────────────────────────────

function parseAttestation(stream) {
  const tag = bytesToHex(stream.read(8));
  const payload = new Stream(stream.readVarbytes(MAX_ATTESTATION_PAYLOAD));
  const type = ATTESTATION_TAGS[tag];

  if (type === 'bitcoin' || type === 'litecoin' || type === 'ethereum') {
    const height = payload.readVaruint();
    if (!payload.atEof()) throw new OtsParseError(`trailing bytes in ${type} attestation`);
    return { type, height };
  }
  if (type === 'pending') {
    const uriBytes = payload.readVarbytes(MAX_URI_LENGTH);
    // Calendar URIs are plain ASCII; anything else is suspect but the
    // attestation itself is still structurally valid.
    const uri = String.fromCharCode(...uriBytes).replace(/[^\x20-\x7e]/g, '?');
    return { type, uri };
  }
  return { type: 'unknown', tag };
}

function parseOp(stream, tag) {
  const type = OP_TAGS[tag];
  if (!type) throw new OtsParseError(`unknown operation tag 0x${tag.toString(16)}`);
  if (type === 'append' || type === 'prepend') {
    return { type, arg: stream.readVarbytes(MAX_OP_ARG_LENGTH, 1) };
  }
  return { type };
}

/** Timestamp tree node: ops is a list of [op, childNode] edges. */
function parseTree(stream, depth = 0) {
  if (depth > MAX_TREE_DEPTH) throw new OtsParseError('proof tree too deep');
  const node = { ops: [], attestations: [] };

  const branch = (tag) => {
    if (tag === TAG_ATTESTATION) {
      node.attestations.push(parseAttestation(stream));
    } else {
      node.ops.push([parseOp(stream, tag), parseTree(stream, depth + 1)]);
    }
  };

  let tag = stream.readByte();
  while (tag === TAG_FORK) {
    branch(stream.readByte());
    tag = stream.readByte();
  }
  branch(tag);
  return node;
}

/**
 * Parse a calendar "upgrade" response: a bare timestamp tree continuing
 * from a pending attestation's commitment message (what
 * `GET <calendar>/timestamp/<commitment-hex>` returns). Evaluate it with
 * `evaluate({ fileDigest: commitment, root })`.
 *
 * @param {Uint8Array|ArrayBuffer} bytes - Raw calendar response body.
 * @returns {object} Op tree root, same shape as {@link parse}'s `root`.
 */
export function parseUpgrade(bytes) {
  const stream = new Stream(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const root = parseTree(stream);
  if (!stream.atEof()) throw new OtsParseError('trailing bytes after upgraded timestamp');
  return root;
}

/**
 * Parse a detached .ots proof. Structure only — no hashing happens here.
 *
 * @param {Uint8Array|ArrayBuffer} otsBytes - Raw contents of the .ots file.
 * @returns {{ fileHashOp: string, fileDigest: Uint8Array, root: object }}
 *   `fileHashOp` names the hash the file was digested with ('sha256', ...),
 *   `fileDigest` is the digest the proof commits to, `root` is the op tree.
 */
export function parse(otsBytes) {
  const bytes = otsBytes instanceof Uint8Array ? otsBytes : new Uint8Array(otsBytes);
  const stream = new Stream(bytes);

  if (!bytesEqual(stream.read(HEADER_MAGIC.length), HEADER_MAGIC)) {
    throw new OtsParseError('not an OpenTimestamps proof (bad magic)');
  }
  const version = stream.readVaruint();
  if (version !== MAJOR_VERSION) {
    throw new OtsParseError(`unsupported proof version ${version}`);
  }

  const fileHashOp = OP_TAGS[stream.readByte()];
  if (!DIGEST_LENGTH[fileHashOp]) {
    throw new OtsParseError('invalid file hash operation');
  }
  const fileDigest = Uint8Array.from(stream.read(DIGEST_LENGTH[fileHashOp]));
  const root = parseTree(stream);
  if (!stream.atEof()) throw new OtsParseError('trailing bytes after proof');

  return { fileHashOp, fileDigest, root };
}

// ── commitment operations ────────────────────────────────────────────

async function sha(alg, msg) {
  return new Uint8Array(await crypto.subtle.digest(alg, msg));
}

async function applyOp(op, msg) {
  if (msg.length > MAX_MSG_LENGTH) throw new OtsError('op message too long');
  switch (op.type) {
    case 'append': {
      const out = new Uint8Array(msg.length + op.arg.length);
      out.set(msg, 0);
      out.set(op.arg, msg.length);
      return out;
    }
    case 'prepend': {
      const out = new Uint8Array(op.arg.length + msg.length);
      out.set(op.arg, 0);
      out.set(msg, op.arg.length);
      return out;
    }
    case 'reverse':
      if (msg.length === 0) throw new OtsError('cannot reverse an empty message');
      return reversed(msg);
    case 'hexlify': {
      if (msg.length === 0) throw new OtsError('cannot hexlify an empty message');
      return new TextEncoder().encode(bytesToHex(msg));
    }
    case 'sha256':
      return sha('SHA-256', msg);
    case 'sha1':
      return sha('SHA-1', msg);
    case 'ripemd160':
      return ripemd160(msg);
    default:
      // keccak256 lands here: it only appears on Ethereum branches, which
      // this verifier does not support.
      throw new OtsError(`unsupported operation: ${op.type}`);
  }
}

/** Hash raw file bytes with the proof's file hash op. */
export async function hashFile(fileBytes, fileHashOp = 'sha256') {
  const bytes = fileBytes instanceof Uint8Array ? fileBytes : new Uint8Array(fileBytes);
  switch (fileHashOp) {
    case 'sha256': return sha('SHA-256', bytes);
    case 'sha1': return sha('SHA-1', bytes);
    case 'ripemd160': return ripemd160(bytes);
    default: throw new OtsError(`unsupported file hash: ${fileHashOp}`);
  }
}

// ── evaluation ───────────────────────────────────────────────────────

/**
 * Execute the proof's operation tree starting from its file digest.
 *
 * Each attestation is returned with the 32-byte message it attests to. For
 * Bitcoin/Litecoin attestations that message, byte-reversed, must equal the
 * merkle root of the attested block — the caller checks that with
 * {@link verifyAgainstHeader} after fetching the header itself.
 *
 * A best-effort `txid` accompanies Bitcoin attestations when the proof
 * embeds the anchoring transaction: the deepest message longer than 64
 * bytes that gets SHA-256'd on the way to the attestation is, in every
 * proof the public calendars produce, the raw transaction — its double-SHA
 * -256 (reversed) is the txid. Callers should treat it as a hint and
 * confirm it against an explorer before displaying it.
 *
 * Branches that fail (unsupported op, malformed message) don't abort the
 * others; they are reported in `errors`.
 *
 * @param {{ fileDigest: Uint8Array, root: object }} proof - Result of {@link parse}.
 * @returns {Promise<{ attestations: Array<object>, errors: string[] }>}
 */
export async function evaluate(proof) {
  const attestations = [];
  const errors = [];

  async function walk(node, msg, txidHint) {
    for (const att of node.attestations) {
      attestations.push({
        ...att,
        msg,
        ...(att.type === 'bitcoin' || att.type === 'litecoin'
          ? { expectedMerkleRoot: bytesToHex(reversed(msg)), txid: txidHint ?? null }
          : {}),
      });
    }
    for (const [op, child] of node.ops) {
      try {
        let hint = txidHint;
        if (op.type === 'sha256' && msg.length > 64) {
          hint = bytesToHex(reversed(await sha('SHA-256', await sha('SHA-256', msg))));
        }
        await walk(child, await applyOp(op, msg), hint);
      } catch (e) {
        if (e instanceof OtsError) errors.push(e.message);
        else throw e;
      }
    }
  }

  await walk(proof.root, proof.fileDigest, null);
  return { attestations, errors };
}

/**
 * Check a Bitcoin/Litecoin attestation against a block header.
 *
 * @param {{ msg: Uint8Array }} attestation - Entry from {@link evaluate}.
 * @param {{ merkleRoot: string, time: number }} header - Block header fields
 *   fetched from a source the caller trusts (ideally several, compared).
 * @returns {number} The block's timestamp (proof-of-existence time).
 */
export function verifyAgainstHeader(attestation, header) {
  if (attestation.msg.length !== 32) {
    throw new OtsError(`expected 32-byte commitment, got ${attestation.msg.length}`);
  }
  const expected = bytesToHex(reversed(attestation.msg));
  if (expected !== String(header.merkleRoot).toLowerCase()) {
    throw new OtsError('commitment does not match block merkle root');
  }
  return header.time;
}

// ── RIPEMD-160 (pure JS; WebCrypto has no support) ───────────────────

const RMD_ZL = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
  1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
  4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
];
const RMD_ZR = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
  6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
  8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
  12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
];
const RMD_SL = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
  7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
  11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
  9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
];
const RMD_SR = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
  9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
  15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
  8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
];
const RMD_KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e];
const RMD_KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];

function rmdF(j, x, y, z) {
  if (j < 16) return x ^ y ^ z;
  if (j < 32) return (x & y) | (~x & z);
  if (j < 48) return (x | ~y) ^ z;
  if (j < 64) return (x & z) | (y & ~z);
  return x ^ (y | ~z);
}

function rotl(x, n) {
  return (x << n) | (x >>> (32 - n));
}

/** RIPEMD-160 of a byte array; returns a 20-byte digest. */
export function ripemd160(msg) {
  // MD-style padding: 0x80, zeros, 64-bit little-endian bit length.
  const bitLen = msg.length * 8;
  const padded = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const X = new Uint32Array(16);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = dv.getUint32(off + i * 4, true);

    let al = h0, bl = h1, cl = h2, dl = h3, el = h4;
    let ar = h0, br = h1, cr = h2, dr = h3, er = h4;

    for (let j = 0; j < 80; j++) {
      const round = j >> 4;
      let t = (rotl((al + rmdF(j, bl, cl, dl) + X[RMD_ZL[j]] + RMD_KL[round]) | 0, RMD_SL[j]) + el) | 0;
      al = el; el = dl; dl = rotl(cl, 10); cl = bl; bl = t;
      t = (rotl((ar + rmdF(79 - j, br, cr, dr) + X[RMD_ZR[j]] + RMD_KR[round]) | 0, RMD_SR[j]) + er) | 0;
      ar = er; er = dr; dr = rotl(cr, 10); cr = br; br = t;
    }

    const t = (h1 + cl + dr) | 0;
    h1 = (h2 + dl + er) | 0;
    h2 = (h3 + el + ar) | 0;
    h3 = (h4 + al + br) | 0;
    h4 = (h0 + bl + cr) | 0;
    h0 = t;
  }

  const out = new Uint8Array(20);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, h0 >>> 0, true);
  ov.setUint32(4, h1 >>> 0, true);
  ov.setUint32(8, h2 >>> 0, true);
  ov.setUint32(12, h3 >>> 0, true);
  ov.setUint32(16, h4 >>> 0, true);
  return out;
}
