// Optional server-side upload: pin one file to IPFS via Pinata and hand the
// CID back — the browser then signs the kind-1063 record (NIP-07) and
// publishes it to the relays itself, exactly like the parent's nostr flow.
// Everything else (Arweave uploads, record publishing, deletion) is fully
// client-side and needs no route here.
//
// Pin ownership registry: every successful pin writes a pin ownership record to storage
// ({ uploader pubkey, Pinata file id, … }). POST /unpin verifies the
// session against that entry before deleting from Pinata — the workers-port
// stand-in for the parent's unpin-on-delete (the server can't watch the
// relays for kind-5 deletions, so the browser calls /unpin right after
// publishing one). First uploader of a CID owns the pin; there is no
// cross-user reference counting (identical uploads by different users are
// rare, and the registry doubles as groundwork for a future dedup table).
//
// Deliberately dropped vs the parent: server-side OTS verification, archive
// extraction/artifact listing, the Lightning fee gate, and the auto-pin
// loop. Pin-at-upload only.

import type { Hono } from "hono";
import type { AppEnv, Env } from "../env.ts";
import { getConfig, IPFS_CID_RE } from "../config.ts";
import { rateLimit } from "../nostr.ts";
import { pinFile, unpinFile } from "../pinata.ts";
import type { UnifiedSession } from "../session.ts";
import { isSameOriginRequest } from "../session.ts";

import { getStore } from "../storage/index.ts";
import type { PinRecord } from "../storage/types.ts";
const readPin = (env: Env, cid: string) => getStore(env).pin(cid);

export function registerUploadRoutes(authed: Hono<AppEnv>): void {
  authed.post("/upload", async (c) => {
    const cfg = getConfig(c.env);
    // 404 (not 403) when Pinata is off: the route simply doesn't exist on
    // this deployment.
    if (!cfg.pinataEnabled) return c.notFound();

    const user = c.get("user") as UnifiedSession;
    if (!isSameOriginRequest(c.req.raw, c.env)) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }
    if (!rateLimit(`upload:${user.did}`, 5, 60_000)) {
      return c.json({ error: "rate limited" }, 429);
    }

    let form: FormData;
    try {
      form = await c.req.raw.formData();
    } catch {
      return c.json({ error: "expected multipart form data" }, 400);
    }
    const entry = form.get("file");
    // FormDataEntryValue is string | File; a string means no real file part.
    const file = entry !== null && typeof entry === "object" ? entry as File : null;
    if (!file || file.size === 0) {
      return c.json({ error: "no file provided" }, 400);
    }
    if (file.size > cfg.pinMaxFileBytes) {
      return c.json({
        error: `file exceeds the ${cfg.pinMaxFileBytes} byte limit`,
      }, 413);
    }

    try {
      const { cid, id } = await pinFile(c.env, file);
      // Ownership registry: first uploader owns the pin; a re-upload by the
      // same owner refreshes the entry (fresher Pinata id).
      if (user.kind === "nostr") {
        const existing = await readPin(c.env, cid);
        if (!existing || existing.uploader === user.pubkey) {
          const entry: PinRecord = {
            uploader: user.pubkey,
            npub: user.npub,
            id,
            fileName: file.name,
            size: file.size,
            at: Date.now(),
          };
          await getStore(c.env).claimPin(cid, entry);
        }
      }
      return c.json({ ok: true, cid, fileName: file.name, size: file.size });
    } catch (err) {
      console.error("[upload] pin failed:", err);
      return c.json({ error: "pinning failed — try again later" }, 502);
    }
  });

  // Unpin-on-delete: called by the browser right after it publishes a
  // kind-5 deletion for an IPFS-backed record. Only the pin's registered
  // uploader may remove it — verified against the KV registry, never
  // client-supplied claims.
  authed.post("/unpin", async (c) => {
    const cfg = getConfig(c.env);
    if (!cfg.pinataEnabled) return c.notFound();

    const user = c.get("user") as UnifiedSession;
    if (!isSameOriginRequest(c.req.raw, c.env)) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }
    if (!rateLimit(`unpin:${user.did}`, 10, 60_000)) {
      return c.json({ error: "rate limited" }, 429);
    }
    if (!(c.req.header("content-type") || "").includes("application/json")) {
      return c.json({ error: "expected application/json" }, 400);
    }

    const body = await c.req.raw.text();
    if (body.length > 2048) return c.json({ error: "body too large" }, 413);
    let cid: unknown;
    try {
      cid = JSON.parse(body)?.cid;
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (typeof cid !== "string" || !IPFS_CID_RE.test(cid)) {
      return c.json({ error: "invalid cid" }, 400);
    }

    const pin = await readPin(c.env, cid);
    if (!pin) return c.json({ error: "unknown cid" }, 404);
    if (user.kind !== "nostr" || pin.uploader !== user.pubkey) {
      return c.json({ error: "not your pin" }, 403);
    }

    try {
      await unpinFile(c.env, { id: pin.id, cid });
    } catch (err) {
      console.error("[unpin] failed:", err);
      return c.json({ error: "unpin failed — try again later" }, 502);
    }
    await getStore(c.env).deletePin(cid, user.pubkey);
    return c.json({ ok: true });
  });
}
