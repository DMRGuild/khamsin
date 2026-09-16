# Khamsin

A browser-first document archive for **Cloudflare Workers or Linux/Node.js**.
Browsers fetch records from Nostr relays and AT Protocol PDSes and verify Nostr
signatures. Operator configuration lives in D1 or SQLite, with compatibility
for existing Workers KV installations. No runtime `data/` directory is needed.

[한국어 안내](README.ko.md)

All five skins, browser scripts, icons, Gentou, and compressed Pandoc WASM are
included. The gzip asset needs neither Git LFS nor R2.

## Start here: register your administrator

Requires **Node.js 22.13+** and npm. SQLite uses Node's built-in `node:sqlite`.

```sh
npm ci
npm run setup
```

The setup wizard asks for the environment and your **public Nostr key** (`npub`
or 64-character hex). Never enter an `nsec` private key. It creates the database,
registers the administrator and access permission together, and generates a
local cookie secret. Re-running setup preserves the existing administrator,
data, and secrets. No manual list editing or seeding is required.

Choose **Cloudflare local** and then run:

```sh
npm run dev
```

Or choose **Linux / Node.js** and run:

```sh
npm run build:node
npm start
```

Open http://localhost:8787, log in with a NIP-07 browser signer, and open `/admin`.
You can edit allowed users, tags, administrators, and trusted HTML slots there.
The last Nostr administrator cannot be removed. Revoking an administrator's
access also revokes their administrator role; revoking only their role retains
ordinary access. Nostr identities are stored as normalized hex keys.

For unattended installation:

```sh
npm run setup -- --target sqlite --admin npub1YOUR_PUBLIC_KEY
# Targets: sqlite, local (D1), remote (production D1).
```

## Deploy to Cloudflare Workers

```sh
npx wrangler login
npx wrangler d1 create khamsin
```

Enable the `[[d1_databases]]` example in `wrangler.toml`, binding `DB`, and set
`database_id` to the returned ID. Local setup enables this block with a local-only
placeholder: replace it before production use. Remove the legacy
`[[kv_namespaces]]` block for a new D1-only deployment. Set the Worker `name`,
`BASE_URL` to your public HTTPS origin, and any site/skin variables.

```sh
npm run setup -- --target remote
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put COOKIE_SECRET
npm run check
npm test
npm run build
npm run deploy
```

Paste the generated secret into Wrangler's prompt. Local `.dev.vars` is never
uploaded. Local and production databases are separate; register the production
administrator explicitly. Setup applies migrations; on later schema updates run
`npx wrangler d1 migrations apply DB --remote` before deployment.

For a custom domain, put a top-level entry before the TOML tables:

```toml
routes = [{ pattern = "archive.example.org", custom_domain = true }]
```

Set `BASE_URL` to that exact public origin, without a path or trailing slash.

## Run on a Linux server

`npm start` loads `.env` if present; existing process environment variables take
precedence. Local setup writes `.env` only if it does not exist.

- `DATABASE_PATH`: defaults to `.state/khamsin.sqlite`. Use a persistent local
  path such as `/var/lib/khamsin/khamsin.sqlite`, writable by the service user.
  Set the same path for setup, import, export, and the server.
- `BASE_URL`: public HTTPS origin in production.
- `COOKIE_SECRET`: a unique random secret of at least 32 characters.
- `HOST` / `PORT`: default `127.0.0.1:8787`.
- `PUBLIC_DIR`: defaults to `./public`.

Run from the project root with `dist/`, `public/`, and production dependencies
available. Use systemd or your process supervisor, with a reverse proxy for TLS.
Only the socket peer's address is trusted for Node rate limiting; behind a proxy,
configure per-client rate limiting at that proxy. Forwarded IP headers are not
trusted automatically. The application limiter remains best effort per process.
SQLite is intended for one host with a persistent disk, not shared network disks.

## Optional import and existing KV migration

`data/` is now an **optional input**, not the source of truth. Import understands
`allowlist.txt`, `admins.txt`, `tags.txt`, and `custom/{slot}.html`. Blank lines and
`#` comments in lists are ignored. Missing files and empty lists make no changes.

```sh
# Preview only; explicit target prevents accidentally writing production.
npm run config:import -- --target sqlite --from ./data
# Apply the merge.
npm run config:import -- --target sqlite --from ./data --apply
```

Lists merge without removing existing entries. Administrators also receive
access permission. Existing HTML and pin ownership are preserved; use
`--overwrite-html` to explicitly replace matching HTML (including empty HTML).
This version deliberately provides merge imports only; remove entries through
`/admin`. A revision check rejects concurrent target changes, and all imported
rows are applied in one SQL statement.

**For an existing deployment, import the current KV rather than stale files.**
Existing KV-only deployments keep working until a `DB` binding is enabled.
When both bindings exist, the application uses D1 exclusively; no fallback mixes
the two stores. Pause admin edits and uploads during the migration:

1. Back up the source KV with your existing operations tooling.
2. Create/configure D1 while keeping `VON_KV` available in `wrangler.toml`.
3. Run `npm run setup -- --target remote` with the intended administrator.
4. Preview, then apply `npm run config:import -- --target remote --from-kv --apply`.
   Omit `--apply` for the preview. This copies lists, HTML, and `pin:*` ownership.
5. Validate the imported configuration, deploy, and check login and `/admin`.
6. Keep the old KV for rollback; remove its binding once migration is verified.

For local KV use `--target local`; `--target sqlite --from-kv` reads local KV.
KV reads are eventually consistent; wait for previous edits to settle before
migration. The legacy `seed:local` / `seed:remote` commands still overwrite KV
and are not part of the new setup flow. Local setup enables D1, so existing local
KV installations should migrate before continuing development.

Export the SQL configuration to a portable JSON file (existing files are never
overwritten), then use it as an import source on either backend:

```sh
mkdir -p backups
npm run config:export -- --target sqlite --output backups/configuration.json
npm run config:import -- --target local --from backups/configuration.json --apply
```

The `backups/` directory is ignored by Git. Keep exports there; arbitrary output
filenames elsewhere are not automatically ignored. `.gitignore` does not remove
files that are already tracked.

Exports include pin ownership but not environment variables or secrets. Import
is a merge, not an exact database restore. Use a database backup for exact recovery.

## Development and customization

- `npm run check`: type-check app, CLI, and tests.
- `npm test`: SQLite/route tests and a local D1 runtime test (opens localhost ports).
- `npm run build`: Workers dry run; `npm run build:node`: Node bundle.
- `npm run dev`: Workers development server with template rebuilds.
- `/admin`: SQL-backed access, tags, roles, and trusted HTML; legacy KV supports
  only the existing allowlist/tag editor and retains eventual consistency.
- Skins: `blackboard`, `chan`, `corp`, `dark`, `harvest`.
- `DISABLE_ZAPS=1`: hide Lightning tipping UI.
- Empty allowed tags means unrestricted; empty allowlist disables login.
- AT Protocol handles/DIDs select authors; only Nostr login is implemented.

Shared Hono routes use a storage interface. `src/cloudflare.ts` handles Workers
bindings and optional R2 caching; `src/node.ts` handles HTTP and static assets.
D1 reads start at the primary so permission changes are not served from replicas.
Eta templates and CSS are bundled at build time for both runtimes.

## Optional storage

Arweave uploads run in the browser using a Wander wallet. Pinata is disabled
by default. To enable it, set `ENABLE_PINATA="1"`, run
`npx wrangler secret put PINATA_JWT`, and redeploy. Pinata unpin requests are
limited to the uploader registered in the database.

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

Cloudflare Workers and ordinary Linux/Node.js servers are supported. Other
serverless providers require runtime/storage adapters. The browser still
uses external CDNs, relays, PDSes, storage gateways, timestamp calendars, and
wallet/signing extensions. Independence means no parent repository or server
is required, not offline operation.

There is no AT Protocol OAuth login, server IPFS node, private archive mode,
or server-side AI. AI features use browser-provided APIs when available.
Record pages render their data client-side, so server-generated record SEO
metadata is limited. Nostr challenges can be replayed within their short TTL;
rate limits are best effort per process/isolate. Keep a strong production cookie secret.

Sources and assets were extracted from von's `workers/` and shared `skins/`.
The original checkout contains no top-level license; this extraction does not
invent a license grant. Pandoc WASM is an existing bundled third-party artifact
(the viewer identifies haskell-wasm as its upstream). Preserve upstream notices
and establish applicable redistribution terms before publishing releases.
