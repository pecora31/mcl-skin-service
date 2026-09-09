# mcl-skin-service

The backend for [MCLv2](https://github.com/pecora31/MCLv2), running on Cloudflare Workers.

It does three jobs the launcher cannot do from a player's machine:

- **Skin sync.** Offline-mode players have no Mojang profile, so by default nobody on a
  small server sees anyone else's skin. This stores skins by name and serves them to
  CustomSkinLoader in every MCLv2 install.
- **CurseForge proxy.** CurseForge's terms forbid disclosing an API key to third parties,
  which an open-source launcher shipping one would do. The key lives here as a Worker
  secret instead.
- **Profile share codes.** A profile becomes a seven-character code that rebuilds it on
  someone else's machine.

## Endpoints

### Skins

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/skins/:username` | Claims a name. Answers with a token **once** — it is stored only as a hash and cannot be recovered. Five claims per address per day. |
| `PUT` | `/v1/skins/:username` | Replaces the skin. Needs `Authorization: Bearer <token>`. |
| `GET` | `/v1/skins/:username.png` | Public. Cached at the edge for thirty days, matching CustomSkinLoader's own cache. |
| `DELETE` | `/v1/skins/:username` | Owner token, or `ADMIN_SECRET` for taking down a reported skin. |

Uploads must be a real PNG of 64×64 or 64×32 under 100KB — checked by reading the IHDR
header rather than trusting the file name.

### CurseForge

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/curseforge/*` | Forwarded to `api.curseforge.com` with the key attached. |

Deliberately not a free CurseForge API for the internet: GET only, and only the four read
endpoints the launcher actually calls (`/v1/mods/search`, `/v1/mods/{id}`,
`/v1/mods/{id}/files`, `/v1/categories`). Upstream headers are stripped so no rate-limit
state leaks, and successful answers are cached for fifteen minutes. Failures are not cached,
so one rate-limited minute does not become a rate-limited quarter of an hour for everyone.

### Share codes

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/shares` | Stores a profile manifest, answers with a code. Twenty per address per day. |
| `GET` | `/v1/shares/:code` | Returns the manifest. Codes are case-insensitive and expire after sixty days. |

Only the manifest is stored — which mod, from which platform, at which version — never the
files. The importing launcher fetches those from Modrinth and CurseForge itself, so nothing
is redistributed here and a share stays a couple of kilobytes.

Manifests are written by one player and read by another, so they are validated before being
stored: known sources only, project ids must be plain ids rather than anything that could be
echoed into an API path on someone else's machine, and both size and addon count are capped.

## Why the free tier shapes the design

Workers allow 100k requests a day; KV allows 100k reads but only **1k writes**. Writes are
the scarce half, which is why skin claims and share codes are rate limited per address, and
why shares get their own KV namespace — a burst of share codes must not starve skin claims.
R2 gives 10GB with free egress, and a skin is a few kilobytes.

## Running it

```bash
npm install
npm test          # unit tests; no network or Cloudflare account needed
npm run typecheck
npm run dev       # local worker on http://localhost:8787
```

To deploy a copy of your own, you need a Cloudflare account — the free tier is enough:

```bash
npx wrangler login
npx wrangler kv namespace create SKIN_REGISTRY
npx wrangler kv namespace create SHARE_REGISTRY
npx wrangler r2 bucket create mcl-skins
```

Put the two namespace ids into `wrangler.toml`, then set the secrets and deploy:

```bash
npx wrangler secret put ADMIN_SECRET          # any long random string
npx wrangler secret put CURSEFORGE_API_KEY    # from console.curseforge.com
npx wrangler deploy
```

Secrets are never committed. `wrangler secret put` stores them on Cloudflare and the Worker
reads them from its environment.

Finally, point the launcher at your deployment: `SKIN_SERVICE_ROOT` in
`src-tauri/src/instance_manager.rs` and `MCL_SERVICE_ROOT` in `src/services/api.ts`.

## Known gaps

- **No way to recover a skin token.** It is stored only as a hash, so a player who
  reinstalls on a new machine cannot reclaim their name. `ADMIN_SECRET` can delete the
  record so they can claim it again.
- `npm audit` reports a vulnerability in `sharp`, which belongs to the local `wrangler dev`
  emulator. It is not part of the deployed Worker and never sees user input.
