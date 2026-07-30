# Fork notes — Saffaboy83/buzz

This is a fork of [block/buzz](https://github.com/block/buzz) that tracks upstream
and deploys the `web/` client to Vercel. Everything in this `fork/` directory,
plus `/vercel.json` and `.github/workflows/sync-upstream.yml`, is fork-local —
nothing upstream owns is modified, so merges stay conflict-free.

## Remotes

| Remote     | URL                                    | Purpose                        |
| ---------- | -------------------------------------- | ------------------------------ |
| `origin`   | `https://github.com/Saffaboy83/buzz.git` | Your fork. Vercel deploys this. |
| `upstream` | `https://github.com/block/buzz.git`      | Block's repo. Fetch only.       |

`upstream`'s push URL is deliberately set to `DISABLED_PUSH_TO_UPSTREAM` so an
absent-minded `git push upstream` fails instead of opening a PR against Block.

## Pulling upstream changes

Three ways, in order of least effort:

**1. Automatic (nothing to do).** `.github/workflows/sync-upstream.yml` runs daily
at 06:17 UTC and merges `block/buzz@main` into this fork's `main` using GitHub's
`merge-upstream` API. A successful sync pushes to `main`, which triggers a Vercel
production deploy. If it can't resolve the merge, it opens an issue labelled
`upstream-sync` instead of failing silently.

**2. On demand, locally.** From `C:\Users\arno_\Buzz`:

```powershell
.\fork\sync-upstream.ps1 -DryRun   # show what would land
.\fork\sync-upstream.ps1           # merge and push
```

Use this when the workflow opens an issue. It runs under your `gh` credential,
which carries the `workflow` scope — the Actions token does not, so a conflicted
merge touching `.github/workflows/**` can only be completed from here.

**3. From GitHub.** The "Sync fork" button on the repo page does the same thing as
option 1. Do **not** use its "Discard commits" option — that deletes the fork-local
deploy config.

## Deployment

Vercel project `buzz` → **https://buzz-eta-five.vercel.app**

It builds from the repo root using `/vercel.json`:

- install: `pnpm install --frozen-lockfile` (workspace root, so the patches apply)
- build: `pnpm --filter buzz-web build`
- output: `web/dist`
- SPA rewrite so TanStack Router deep links survive a refresh
- Node pinned to 22.x; `ENABLE_EXPERIMENTAL_COREPACK=1` so Vercel honours
  `packageManager: pnpm@11.4.0` instead of falling back to its own pnpm

### Why there's a deploy hook

On the Hobby plan Vercel refuses to build a commit whose author isn't tied to
the account. Your own pushes deploy normally, but the daily sync's merge commit
is authored by `github-actions[bot]`, so pushing it would silently not deploy.

The workflow therefore calls a Vercel deploy hook after a successful sync. The
hook URL lives in the repo secret `VERCEL_DEPLOY_HOOK_URL` — it is a credential
(anyone holding it can trigger a build), so it is never committed. Rotate it by
deleting and recreating the hook in Vercel → Settings → Git → Deploy Hooks, then:

```bash
gh secret set VERCEL_DEPLOY_HOOK_URL --repo Saffaboy83/buzz
```

## The relay (Railway)

Buzz is self-hosted by design — the client talks to *your* relay, and unconfigured
it assumes the relay shares its origin. Vercel is static hosting, so the client
needs a relay pointed at explicitly.

Railway project **`buzz-relay`** → **wss://relay-production-61de.up.railway.app**

| Service    | Image                    | Volume                  | Notes                                   |
| ---------- | ------------------------ | ----------------------- | --------------------------------------- |
| `relay`    | `ghcr.io/block/buzz:main` | `/data/git`             | public on port 3000                     |
| `postgres` | `postgres:17-alpine`     | `/var/lib/postgresql/data` | private network only                 |
| `redis`    | `redis:7-alpine`         | `/data`                 | private network only                    |
| `minio`    | `minio/minio:latest`     | `/bitnami/minio/data`   | S3 for media + git packs; private only  |

The client reaches it because `VITE_RELAY_URL` is set in Vercel. It is a *build-time*
Vite variable, so changing it requires a redeploy, not just a settings save.

### Things that will bite you here

- **`RAILWAY_RUN_UID=0` is load-bearing.** The Buzz image runs as `buzz` (uid 1000)
  and Railway mounts volumes root-owned, so without it the relay dies on boot with
  `BUZZ_GIT_PACK_CACHE_PATH … Permission denied`.
- **Redis's password is written literally into its start command.** Railway did not
  expand `$REDIS_PASSWORD` there, and the relay failed auth against a Redis that had
  taken the unexpanded string as its password.
- **MinIO's data dir is the volume mount path**, and `buzz-media` is a plain
  directory inside it — MinIO's filesystem backend treats a top-level directory as a
  bucket, which replaces the `mc mb` init container upstream's compose uses.
- **Railway's native Storage Buckets did not work** — `bucketCreate` succeeds but the
  bucket instance never provisions, so `bucketS3Credentials` returns
  `BucketInstance not found`. Hence MinIO.
- **`BUZZ_GIT_CONFORMANCE_PROBE=true` is a genuine health gate.** The relay refuses
  to start unless it can round-trip an object through S3, so a clean boot proves the
  storage wiring rather than merely suggesting it.

### Secrets

Generated at setup, stored only in Railway's env vars (`buzz-relay` → each service →
Variables): `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `BUZZ_RELAY_PRIVATE_KEY`,
`BUZZ_GIT_HOOK_HMAC_SECRET`, `BUZZ_S3_ACCESS_KEY` / `BUZZ_S3_SECRET_KEY`.

The **relay owner identity** — the account that administers the relay — is at
`C:\Users\arno_\.buzz-relay-owner-key.txt`. Import that `nsec` into the Buzz client
to act as owner. `RELAY_OWNER_PUBKEY` on the relay is its public half; the relay
runs in closed mode (`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`) and refuses to boot
without a valid one.

## Upstream's CI is disabled here

The fork inherited 12 workflows from Block —
Rust CI, Docker publishing, Helm charts, signed macOS/Windows canaries. They fire
on every push, need secrets this account doesn't have, and burn Actions minutes.
All 12 are disabled; only `Sync fork with upstream` is active. Re-enable any of
them with:

```bash
gh workflow enable "CI" --repo Saffaboy83/buzz
```

## Desktop agent latency

Symptom: saying "hi" took over a minute for an agent to answer.

It was not the relay. Measured from this machine: **108 ms** median HTTP RTT and
~200 ms WSS connect-to-AUTH against Railway. The cost was local.

`managed-agents.json` had **10 agent entries, all active, every one at
`parallelism: 10`**. Parallelism is not a throughput dial — the ACP startup log
shows it spawning real Node child processes (`agent=0` … `agent=9` →
`agent_pool_ready agents=10`). So each running agent is 1 supervisor + 10
`claude-agent-acp` Node processes. Three agents had actually started: **33
processes**. On a 15.7 GB machine with ~2 GB free (claude, node, and ChatGPT
already resident), that swaps, and swapping is where the minute went.

Applied in `%APPDATA%\xyz.block.buzz.app\agents\` (backups alongside, suffixed
`.bak-before-tuning`):

| Setting | Was | Now | Why |
| --- | --- | --- | --- |
| `BUZZ_ACP_AGENTS` (global env) | unset → 10 | `2` | caps every agent's pool |
| `CLAUDE_CODE_EFFORT_LEVEL` | unset | `low` | fable-5 is adaptive/xhigh-capable; "hi" does not need a reasoning budget |
| `parallelism` per agent | 10 | 2 | belt and braces with the env cap |
| active agents | 10 | 1 (Fabey) | one responder beats four talking over each other |
| `turn_timeout_seconds` | 320 | 90 | a hung turn surfaces instead of stalling |
| `start_on_app_launch` | false | true (Fabey) | pool spawn is paid at launch, not charged to your first message |

Worst case went from **110 processes to 12**; in practice 3.

Re-apply any time (with the app closed) — it is idempotent:

```bash
python fork/tune-desktop-agents.py
```

### The one that matters if you touch this again

**The app rewrites `managed-agents.json` on every launch.** It re-seeds the
builtin personas (fizz/honey/bumble) as *new, active* entries at the hardcoded
`DEFAULT_AGENT_PARALLELISM = 10`, with empty pubkeys. Deleting the Welcome Team
from `teams.json` does **not** stop it — they come from the builtin persona seed,
not the team. So editing that file is not durable on its own.

What *is* durable is the global env layer. `runtime.rs` writes
`BUZZ_ACP_AGENTS` from the record at line 729, then writes user `env_vars`
**last** (line 860) so they win, and `BUZZ_ACP_AGENTS` is not in
`RESERVED_ENV_KEYS` — so the global cap survives every re-seed. Put
performance limits in `global-agent-config.json`, not in per-agent records.

A proper fix (raising the default, stopping the re-seed) is a code change, and
this machine has no `cargo`/`rustc` — rebuilding the Tauri desktop app from this
fork would mean installing the Rust toolchain first.
