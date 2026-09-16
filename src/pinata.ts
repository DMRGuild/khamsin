// Optional IPFS pinning via Pinata (no local Kubo on Workers). Enabled only
// when ENABLE_PINATA=1 AND the PINATA_JWT secret is set; otherwise the
// /upload route 404s and the upload form never shows the IPFS option.

import { IPFS_CID_RE } from "./config.ts";
import type { Env } from "./env.ts";

const PINATA_UPLOAD_URL = "https://uploads.pinata.cloud/v3/files";
const PINATA_API = "https://api.pinata.cloud";

/**
 * Pins one file to Pinata's public IPFS network. Returns the CID plus
 * Pinata's own file id (needed for v3 deletion; null when the response
 * doesn't carry one). (Legacy fallback, should v3 misbehave: POST
 * https://api.pinata.cloud/pinning/pinFileToIPFS returns `IpfsHash`.)
 */
export async function pinFile(
  env: Env,
  file: File,
): Promise<{ cid: string; id: string | null }> {
  const fd = new FormData();
  fd.set("file", file, file.name || "upload");
  fd.set("network", "public");
  const res = await fetch(PINATA_UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.PINATA_JWT}` },
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[pinata] upload failed (${res.status}): ${detail.slice(0, 500)}`);
    throw new Error(`pinning failed (${res.status})`);
  }
  const data = await res.json().catch(() => null) as
    | { data?: { cid?: unknown; id?: unknown } }
    | null;
  const cid = data?.data?.cid;
  // Never trust the API response shape blindly — the CID lands in records
  // and gateway URLs.
  if (typeof cid !== "string" || !IPFS_CID_RE.test(cid)) {
    throw new Error("pinning succeeded but returned an unusable CID");
  }
  const rawId = data?.data?.id;
  const id = typeof rawId === "string" && /^[A-Za-z0-9-]{1,100}$/.test(rawId)
    ? rawId
    : null;
  return { cid, id };
}

/**
 * Removes a pinned file. Tries the v3 files API by id first, then falls
 * back to the legacy unpin-by-CID endpoint (covers registry entries without
 * an id and v3 API drift). Throws when neither succeeds.
 */
export async function unpinFile(
  env: Env,
  { id, cid }: { id: string | null; cid: string },
): Promise<void> {
  const headers = { Authorization: `Bearer ${env.PINATA_JWT}` };
  if (id) {
    const res = await fetch(
      `${PINATA_API}/v3/files/public/${encodeURIComponent(id)}`,
      { method: "DELETE", headers },
    );
    if (res.ok) return;
    console.warn(`[pinata] v3 delete failed (${res.status}); trying legacy unpin`);
  }
  const legacy = await fetch(
    `${PINATA_API}/pinning/unpin/${encodeURIComponent(cid)}`,
    { method: "DELETE", headers },
  );
  if (!legacy.ok) {
    const detail = await legacy.text().catch(() => "");
    console.error(`[pinata] unpin failed (${legacy.status}): ${detail.slice(0, 300)}`);
    throw new Error(`unpin failed (${legacy.status})`);
  }
}
