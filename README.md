# Khamsin

A standalone, lightweight document archive for **Cloudflare Workers**. Derived
from von's serverless edition; no parent checkout, Deno server, Docker, local
IPFS node, or asset synchronization is needed.

[한국어 안내](README.ko.md)

The Worker renders page shells and handles Nostr login. Browsers fetch records
from Nostr relays and AT Protocol PDSes and verify Nostr signatures. Operator
lists and custom HTML live in Workers KV. All five skins, browser scripts,
icons, the Gentou viewer, and compressed Pandoc WASM are included in this repo.
The ~16 MB gzip asset requires neither Git LFS nor R2.

## Local quick start

Requires Node.js 22+ and npm. Replace `<repository-url>` with this repository's
published Git URL (the local extraction does not publish a remote).

```sh
git clone <repository-url> khamsin
cd khamsin
npm ci
npm run setup
# Put YOUR npub in BOTH data/admins.txt and data/allowlist.txt.
npm run seed:local
npm run dev
```

Open http://localhost:8787. `setup` creates a random local cookie secret and
copies empty example lists only when files do not exist; it preserves your
edits. Login requires a NIP-07 Nostr browser signer. An empty allowlist disables
login; admins must also be allowlisted. Local configuration is ignored by Git,
so a fresh clone does not grant anyone administrator access.

## Deploy to Cloudflare Workers

1. Run the local setup above and configure your operator lists.
2. Log in and create your own KV namespace:

   ```sh
   npx wrangler login
   npx wrangler kv namespace create VON_KV
   ```

3. In `wrangler.toml`, uncomment `id` under `[[kv_namespaces]]` and replace it
   with the returned namespace ID. Set `name` to your Worker name and `BASE_URL`
   to `https://<worker-name>.<your-workers-subdomain>.workers.dev` (find your
   subdomain in the Cloudflare dashboard), or your configured custom origin.
   Customize `SITE_NAME`, `SITE_DESCRIPTION`, and `SKIN` as desired.
4. Generate a production secret, then paste it into the secret prompt:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   npx wrangler secret put COOKIE_SECRET
   ```

   Wrangler may offer to create the Worker before its first deployment; accept.
   `.dev.vars` is local only and is never uploaded as production secrets.
5. Seed production data and deploy:

   ```sh
   npm run seed:remote
   npm run check
   npm run build
   npm run deploy
   ```

`seed:remote` **overwrites** existing KV keys for files present in `data/`.
Use it for initial setup or intentional replacement: it can overwrite changes
made through `/admin`. Missing files are skipped; an empty file clears a key.
`npm run deploy` checks for a public HTTPS origin and a real namespace ID.
There is no preconfigured account, custom domain, or existing production KV ID.

For a custom domain, add a top-level `routes` entry before the TOML tables:

```toml
routes = [{ pattern = "archive.example.org", custom_domain = true }]
```

Also update `BASE_URL` to the exact public origin, with no path or trailing slash.
The local `.dev.vars` keeps `BASE_URL=http://localhost:8787` for development.
Cloudflare configuration references: [Wrangler](https://developers.cloudflare.com/workers/wrangler/configuration/)
and [KV bindings](https://developers.cloudflare.com/kv/concepts/kv-bindings/).

## Commands and customization

| Command | Purpose |
| --- | --- |
| `npm run setup` | Create missing local settings without overwriting them |
| `npm run dev` | Compile templates and start local Workers runtime |
| `npm run check` | TypeScript validation |
| `npm run build` | Compile templates and dry-run the deployment into `dist/` |
| `npm run deploy` | Validate configuration, compile templates, deploy |
| `npm run seed:local` / `npm run seed:remote` | Replace local / production KV lists and HTML slots |

The Wrangler build hook precompiles Eta templates (Workers disallows runtime
code generation), including when using `npx wrangler dev` or `deploy` directly.
Changes under `views/` trigger compilation during development.

- `data/allowlist.txt`: Nostr npubs/hex keys or AT Protocol handles/DIDs, one per
  line. Nostr entries enable login; AT Protocol entries select authors to read.
- `data/admins.txt`: Nostr administrators; also add them to the allowlist.
- `data/tags.txt`: allowed newsgroup tags; empty means unrestricted.
- `data/custom/*.html`: trusted HTML slots named `index`, `about`, `main-header`,
  `main-footer`, `sidebar-header`, or `sidebar-footer`.
- Lines starting with `#` and blank lines are ignored in text lists.
- `/admin` edits allowlist and tags. Admins and HTML are CLI-managed. KV is
  eventually consistent; updates may take ~60 seconds or more to propagate.
- Skins: `blackboard`, `chan`, `corp`, `dark`, `harvest`.
- `DISABLE_ZAPS=1` hides Lightning tipping UI; set `0` to show it.
- Protocol collection names and `window.VON` remain compatible with existing
  records; they are protocol identifiers, not dependencies on a parent checkout.

## Optional storage

Arweave uploads run in the browser using a Wander wallet. Pinata is disabled
by default. To enable it, set `ENABLE_PINATA="1"`, run
`npx wrangler secret put PINATA_JWT`, and redeploy. Pinata unpin requests are
limited to the uploader registered in KV.

The bundled `public/gentou/pandoc.wasm.gz` is sufficient for normal viewing.
For an optional uncompressed fallback:

```sh
npx wrangler r2 bucket create khamsin-gentou
npm run upload:wasm -- --remote khamsin-gentou
```

Uncomment the `GENTOU_BUCKET` block in `wrangler.toml` and deploy. The upload
script decompresses the included asset into a temporary file and cleans it up.
R2 is unnecessary for the default deployment.

## Scope and provenance

This implementation targets Cloudflare Workers APIs (KV, Static Assets, and
optional R2); other serverless providers require adapters. The browser still
uses external CDNs, relays, PDSes, storage gateways, timestamp calendars, and
wallet/signing extensions. Independence means no parent repository or server
is required, not offline operation.

There is no AT Protocol OAuth login, server IPFS node, private archive mode,
or server-side AI. AI features use browser-provided APIs when available.
Record pages render their data client-side, so server-generated record SEO
metadata is limited. Nostr challenges can be replayed within their short TTL;
rate limits are best effort per isolate. Keep a strong production cookie secret.

Sources and assets were extracted from von's `workers/` and shared `skins/`.
The original checkout contains no top-level license; this extraction does not
invent a license grant. Pandoc WASM is an existing bundled third-party artifact
(the viewer identifies haskell-wasm as its upstream). Preserve upstream notices
and establish applicable redistribution terms before publishing releases.
