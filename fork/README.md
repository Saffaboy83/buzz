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

## Agents can't reach the relay: Norton TLS interception

**This is the one that actually breaks agents.** `buzz-acp` dies on startup with:

```
initial relay connect failed with terminal error:
  WebSocket error: IO error: invalid peer certificate: UnknownIssuer
Error: relay connect error: ...
```

Norton Antivirus is intercepting HTTPS and re-signing it. The certificate this
machine receives for the relay is issued by
`CN=Norton Web/Mail Shield Root, OU=generated by Norton Antivirus for SSL/TLS scanning`
— not by Railway's real CA.

The workspace pins `tokio-tungstenite` with the **`rustls-tls-webpki-roots`**
feature (root `Cargo.toml`), which compiles in Mozilla's root list and ignores
both the Windows trust store and `SSL_CERT_FILE`. Norton's root *is* installed
in `Cert:\LocalMachine\Root` and `Cert:\CurrentUser\Root`, so browsers, Node
(with `NODE_EXTRA_CA_CERTS`) and the web client are all fine — but `buzz-acp`
structurally cannot trust it. There is no escape hatch: `relay.rs` calls
`connect_async` with the default connector and no custom-CA or insecure option,
and it classifies rustls handshake failures as **terminal**, so it does not even
retry.

Confirmed by direct measurement:

```
node without the corporate CA bundle -> FAIL: UNABLE_TO_VERIFY_LEAF_SIGNATURE
node with    the corporate CA bundle -> OK 200
openssl s_client issuer               -> Norton Web/Mail Shield Root
```

Same failure family as the Railway CLI, which is also a rustls binary with a
bundled root store and likewise cannot talk to its API from this machine.

**Two ways out.**

1. *Fastest, fixes everything system-wide:* stop Norton scanning HTTPS for this
   host — Norton → Settings → Firewall / Web Protection → **exclude
   `relay-production-61de.up.railway.app`** (or disable "Encrypted connections
   scanning"). This also un-breaks the Railway CLI and `curl`. Narrow the
   exclusion to the host rather than switching scanning off globally.

2. *Code fix in this fork* (needs a Rust toolchain — this machine has no
   `cargo`/`rustc`). In the root `Cargo.toml`:

   ```diff
   -tokio-tungstenite = { version = "0.29", features = ["rustls-tls-webpki-roots"] }
   +tokio-tungstenite = { version = "0.29", features = ["rustls-tls-native-roots"] }
   ```

   `native-roots` reads the platform trust store, which already contains
   Norton's root — verified present. Then `cargo build --release -p buzz-acp`
   and drop the binary over `%LOCALAPPDATA%\Buzz\buzz-acp.exe`. This edits a
   file upstream owns, so unlike everything else in this fork it can conflict on
   a sync; keep the diff to that one line.

Until one of these is done, agents crash-loop on startup and no amount of
config tuning will make them answer.

### The local TLS proxy is a dead end — do not build one

This looks like the obvious third option, and it was tried and removed: run a
loopback proxy so Node terminates TLS (it trusts Norton via
`NODE_EXTRA_CA_CERTS`) and re-exposes plain `ws://127.0.0.1:8787`, then point
the workspace at that.

The transport works — the WebSocket upgrade returns the relay's NIP-42 AUTH
frame with no CA trust on the client side, and keep-alive HTTP requests return
200. **Authentication is what fails**, and only once a real read is attempted:

```
relay returned 401 Unauthorized: NIP-98 HTTP Auth verification failed:
URL mismatch: event has `http://127.0.0.1:8787/query`,
              expected `https://relay-production-61de.up.railway.app/query`
```

Buzz signs the relay URL *into* its auth events, so a proxy would have to
re-sign them — which needs the private key. Specifically:

- `nip98_expected_url()` in `crates/buzz-relay/src/api/bridge.rs` builds the
  expected URL as `{scheme}://{tenant.host()}{path}`, with the scheme pinned to
  the deployment's TLS posture. A client reached over `ws://` derives `http://`
  and can never match an `https://` deployment.
- A test in that same file deliberately keeps the derivation independent of
  request headers (it calls a header-derived version a "host-binding side
  door"), so no `X-Forwarded-Proto` / `X-Forwarded-Host` trick helps.
- Routing *only* the agents through the proxy does not save it either.
  `buzz-acp` depends on `reqwest` and does all reads via `POST /query` and all
  writes via `POST /events`, both NIP-98 authed — it is not WebSocket-only.

Fix the trust store (option 1 or 2). There is no transport-level workaround.

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

### Measured, before and after

Baseline came off the wire, not from a stopwatch — the channel's own kind-9
events carry `created_at`, so the original turns are recoverable:

| Turn | Sent | Replied | Latency |
| --- | --- | --- | --- |
| `@Fabey hi` | 03:27:41 | 03:29:20 | **99 s** |
| `@Fizz hi` | 03:31:08 | 03:32:07 | **59 s** |

After tuning, measured by posting as the owner through the HTTP bridge and
polling for the reply. Each prompt carries a unique token the reply must echo —
without that, a late reply from the previous turn gets matched and reports an
impossible 1.6 s:

| Turn | Latency |
| --- | --- |
| first message (cold — pool spawns lazily) | 33.9 s |
| warm | 16.3 s |
| warm | 11.4 s |
| warm | 13.0 s |

**Warm median 13 s, against a 59–99 s baseline: roughly 5–8x.** The log confirms
the cap took effect — `agent_pool_ready agents=2`, down from `agents=10`.

Not the full 10x, and the remaining gap is understood rather than mysterious.
Driving the same harness directly over ACP (`initialize` → `session/new` →
`session/prompt`) costs:

| Phase | Cost |
| --- | --- |
| spawn + init | 0.4 s |
| `session/new` | 7.0 s |
| the model turn itself | 4.3 s |

So ~4 s of the 13 s is the model and ~9 s is Buzz overhead. Closing that means
attacking `session/new`, not the pool. Two things that did **not** help, both
measured rather than assumed:

- `CLAUDE_CODE_EFFORT_LEVEL=low` — 12.2 s vs 12.7 s at default. Noise. It buys
  nothing and costs answer quality, so it is not worth keeping.
- Relay latency — 108 ms median HTTP RTT, ~200 ms WSS connect-to-AUTH. Never a
  factor at this scale.

### Where the remaining seconds are

Two levers are left, both measured, and both cost something — neither is free
speed, which is why neither was applied unilaterally.

**1. The 28 KB system prompt costs ~3.1 s on every turn.** Same harness, same
`cwd`, only the prompt differs:

| | warm turn |
| --- | --- |
| no system prompt | 3.8 s |
| the real 28 KB prompt | 6.9 s |

It is assembled from three places, and only the first is injected over ACP:

| Source | Size |
| --- | --- |
| `base_prompt.md` (via `systemPrompt`) | 13,734 B |
| `~/.buzz/AGENTS.md` (read from cwd) | 3,828 B |
| `~/.buzz/.agents/skills/buzz-cli/SKILL.md` | 11,014 B |

`BUZZ_ACP_BASE_PROMPT_FILE` can point the first one at something smaller. The
other two are written to disk by `nest.rs` and restored whenever
`NEST_SKILL_VERSION` / `NEST_AGENTS_VERSION` outranks the version file, so
deleting them is not durable.

The catch: that 11 KB skill is what teaches an agent to drive the `buzz` CLI —
clone repos, open PRs, push patches. Trimming it makes "hi" faster and makes the
agent worse at the work it exists to do. Worth it for a chat-only persona,
wrong for a working one.

**2. The pool spawns lazily on first message**, not at launch, which is why the
first turn costs 33.9 s against a 13 s warm one. `BUZZ_ACP_HEARTBEAT_INTERVAL`
(default `0`, disabled) sends periodic prompts and would keep both the pool and
the session warm. It costs tokens continuously in exchange for never paying the
cold start.

### Ruled out, with numbers

Recorded so none of these get re-litigated:

| Suspect | Verdict |
| --- | --- |
| Relay latency | 108 ms median RTT — never a factor |
| Norton TLS interception | agents connect fine *with* Norton re-signing; it broke `buzz-acp` startup, never turn latency |
| `CLAUDE_CODE_EFFORT_LEVEL=low` | 12.2 s vs 12.7 s — noise, and it costs answer quality |
| Agent working directory | already `~/.buzz` (14 entries), not a large repo |
| Session churn | `channel_id → session_id` is cached; sessions are reused |

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
