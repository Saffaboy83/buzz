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

### The 2026-08-02 incident: three days of silent drift

The scheduled sync failed on Jul 31, Aug 1, and Aug 2 — upstream had touched
`.github/workflows/**` (7 commits' worth), which the Actions `GITHUB_TOKEN`
cannot merge (HTTP 422, `workflows` permission). That is the *known* failure the
issue-alert was designed for. What made it silent: **issues were disabled on the
repo**, so `gh issue create` died and the alert was swallowed. Two stacked
defects — the second hid the first for 3.2 days / 76 commits.

Repairs applied 2026-08-02, all verified:

- **Issues are enabled and must stay enabled** (`gh api -X PATCH repos/Saffaboy83/buzz -F has_issues=true`).
  The failure path has no other channel — no issue-writes means no alert at all.
- Backlog cleared with `.\fork\sync-upstream.ps1` (merge `7a8d942f6`, clean, pushed).
- **A synced-in workflow arrives *active*.** Upstream's new
  `desktop-release-candidate.yml` registered itself active on push and had to be
  disabled to restore the only-sync-active invariant. After any sync that adds a
  workflow file, run `gh workflow list --repo Saffaboy83/buzz --all | grep -i active`.
- Post-repair dispatch run: green, 10s, no-op — the pipe works when nothing blocks it.

Still true afterwards: the scheduled Action will 422 again the next time upstream
touches a workflow file — that class is structural to `GITHUB_TOKEN`. The issue
alert now fires when it happens, and the fix is the local script. The durable fix
would be a fine-grained PAT with `workflow` scope stored as a repo secret and a
git-based merge in the Action; not done — minting that PAT is a manual step.

Also observed, harmless but worth knowing: the 06:17 UTC cron actually starts
08:35–09:19 UTC (GitHub scheduler queue delay), and the deploy-hook step has
never yet executed for real — every genuine merge so far has been pushed locally
(user-authored commits deploy via git integration, so the hook wasn't needed).

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

> **RESOLVED 2026-08-02.** The relay host is excluded from Norton's scanning:
> Norton → Security → Advanced → **Safe Web → Exclusions**, entries
> `http://relay-production-61de.up.railway.app/*` and the `https://` twin.
> Verified in the same minute: the relay presented a Let's Encrypt issuer while
> `github.com` still showed the Norton root — interception on, relay exempt. So
> agent starts now work regardless of Norton's cycle. The Railway CLI's host
> (`backboard.railway.com`) is **not** excluded and the CLI stays broken; add it
> the same way if it's ever wanted. The section below stands as the diagnosis
> record and for the day the exclusion list gets reset.

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

### It toggles, and while it is on nothing else about agents can be measured

Re-checked 2026-08-02 (twice — the second pass corrected the first). Interception
is **not** constant, and it cycles on a shorter period than this table first
implied:

| Window (UTC) | Agent starts | Outcome |
| --- | --- | --- |
| 2026-07-30 03:25 | 1 | connected, subscribed to the channel |
| 2026-07-30 04:24 → 11:31 | 3 | every one died on `invalid peer certificate` |
| 2026-07-31 02:50 → 04:00 | 4 | connected, subscribed, answered — all the good numbers came from here |
| 2026-07-31 04:06 → 2026-08-02 17:11 | 10 | every one died on `invalid peer certificate` |
| 2026-08-02 17:24 → 17:55 | 4 | connected, subscribed — a ~44-minute clean window |
| 2026-08-02 by 18:03 | — | interception re-engaged (`openssl` shows the Norton root again) |

Nothing in Buzz changed across those boundaries. Norton's encrypted-connections
scanning engages and disengages on its own schedule. When it is on, `buzz-acp`
reaches `agent_pool_ready` and *then* exits on the relay connect, so the symptom
is "agent silently absent", not "agent slow".

**Established sessions survive interception switching on.** Found 2026-08-02:
agents that connected during the 17:24–17:55 window kept their websockets and
kept answering after 18:03, while `openssl` against the same host showed Norton's
root. Interception only breaks the *handshake*, so "the agents look fine" and
"openssl says Norton" can both be true at the same moment. The corollary: a
running agent proves nothing about whether a *new* start would succeed — check
with `openssl s_client` (issuer = Norton means new starts die), and never
restart a working agent while interception is on.

It is **host-selective** — Norton keeps its own allowlist. Measured the same day
with `openssl s_client`:

| Host | Issuer seen |
| --- | --- |
| `relay-production-61de.up.railway.app` | Norton Web/Mail Shield Root |
| `github.com` | Norton Web/Mail Shield Root |
| `buzz-eta-five.vercel.app` | Norton Web/Mail Shield Root |
| `api.anthropic.com` | Google Trust Services (**not** intercepted) |

So Norton already exempts a host it cares about. Adding the relay host to that
same exclusion list is the low-risk fix — it is a change to antivirus settings,
so it has to be made by hand in Norton's UI.

**Why Node tooling never noticed.** Norton drops its scanning root at
`C:\ProgramData\Norton\Antivirus\wscert.pem` and this machine exports
`NODE_EXTRA_CA_CERTS` pointing at it, so every Node process trusts the
re-signed chain transparently. That masks the problem and will mislead a
diagnostic: a plain `fetch()` from Node returns 200 against an intercepted host
and looks like proof that interception is off. Unset the variable to get a
truthful answer —

```
node                          -> OK 200        (inherits Norton's bundle)
env -u NODE_EXTRA_CA_CERTS node -> UNABLE_TO_VERIFY_LEAF_SIGNATURE
```

The second line is what `buzz-acp` sees.

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
| `CLAUDE_CODE_EFFORT_LEVEL` | unset | `low`, then **reverted to unset** | never confirmed live; see the verdict below |
| `parallelism` per agent | 10 | 2 | belt and braces with the env cap |
| active agents | 10 | 1 (Fabey) | one responder beats four talking over each other |
| `turn_timeout_seconds` | 320 | 90 | a hung turn surfaces instead of stalling |
| `start_on_app_launch` | false | true (Fabey) | pool spawn is paid at launch, not charged to your first message |

Worst case went from **110 processes to 12**; in practice 3.

### Result

| | before | after | |
| --- | --- | --- | --- |
| first message ("hi") | **99 s** | **10.2 s** | **9.7x** |
| steady state | ~59–99 s | **10.6 s** | |

After, n=3 each, measured over a NIP-42 WebSocket subscription (the transport
the desktop actually receives on), each prompt carrying a token the reply must
echo:

- cold: 10.0 / 10.2 / 11.5 s — median **10.2 s**
- warm: 10.6 / 9.8 / 13.4 s — median **10.6 s**

Cold and warm are now the same number. That is the point of pre-warming: the
first message stops costing more than any other, so there is no longer a 34 s
opening turn followed by 13 s ones.

Two settings did it, both in `global-agent-config.json`, both verified live in
the running app rather than inferred:

```json
{ "env_vars": { "BUZZ_ACP_AGENTS": "2", "BUZZ_ACP_LAZY_POOL": "false" } }
```

A third was set on 2026-07-31 and **removed again on 2026-08-02**:
`CLAUDE_CODE_EFFORT_LEVEL: "low"`. It never earned the live confirmation it
needed, and the attempt to get it was blocked — see *Effort level* below.

The agent picks these up **without restarting Buzz** — `auto_restart_on_config_change`
respawns it on a config write. Confirmed in the log: config written 03:36:44,
agent restarted 03:39:08, `agent_pool_ready agents=2` at 03:39:10 — 1.9 s after
launch and *before* the relay connect, where it used to appear only when the
first message arrived.

That also makes cold-path measurement repeatable: rewrite the config file to bump
its mtime, wait for a fresh `agent_pool_ready`, then time one message.

**Caveat found on 2026-08-02:** that trick restarts a *running* agent. It does
nothing when `buzz-acp` has already exited — a config write against a dead agent
produces no new log line and no respawn, because there is no process to restart.
If the log's last entry is an error rather than a subscription, restart Buzz
itself; `start_on_app_launch` is what spawns the agent from cold.

### How it was measured, before and after

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

**The system prompt is NOT the lever — measure twice before trading it away.**
A single sample said the 28 KB prompt cost 3.1 s per turn, which would have
justified cutting the `buzz-cli` skill. Repeating it showed that number was
noise:

| system prompt | warm turn, run 1 | warm turn, run 2 |
| --- | --- | --- |
| none | 3.81 s | 3.57 s |
| `base_prompt.md` only (13.7 KB) | **7.30 s** | **3.87 s** |
| trimmed to 7.3 KB | — | 3.60 s |

Identical configuration varying by 2x. Prompt caching is working; halving the
prompt buys **0.27 s**. Any per-turn conclusion drawn from one sample here is
worthless — take at least three.

For the record, since it is easy to re-derive wrongly: the ~28 KB an agent
carries comes from `base_prompt.md` (13,734 B, injected via `systemPrompt`),
`~/.buzz/AGENTS.md` (3,828 B) and `~/.buzz/.agents/skills/buzz-cli/SKILL.md`
(11,014 B), the last two read from the working directory. Adding the skill on
top of the base prompt costs nothing measurable — it is progressively
disclosed, not pasted into every turn. `BUZZ_ACP_BASE_PROMPT_FILE` will
override the first if a future measurement ever justifies it. Nothing here
justifies it today.

**The pool spawns lazily on first message**, not at launch, which is why the
first turn costs 33.9 s against a 13 s warm one. This matters more than the warm
number: the original 99 s and 59 s were both *first* messages, so the cold path
is the one actually experienced.

`BUZZ_ACP_HEARTBEAT_INTERVAL` looks like the fix and is not — `lib.rs` logs
`heartbeat_skipped_pool_not_ready`, so heartbeats only run once the pool already
exists. It cannot pre-warm the thing it depends on, and it self-prompts, which
risks channel noise.

The actual control is **`BUZZ_ACP_LAZY_POOL`**. `runtime.rs:582` sets it from a
per-spawn flag, it is **not** in `RESERVED_ENV_KEYS`, and it is written before
user `env_vars` at ~860 — so a global override wins, exactly as the pool cap
does. Set in `global-agent-config.json`:

```json
{ "env_vars": { "BUZZ_ACP_AGENTS": "2", "BUZZ_ACP_LAZY_POOL": "false" } }
```

Takes effect on the next agent spawn (restart Buzz). The pool is then built at
launch instead of being charged to the first message.

Verified in isolation rather than assumed — `buzz-acp` run directly with a
throwaway key, which reaches the pool-spawn decision before it ever needs to be
a relay member:

| | order of operations |
| --- | --- |
| `LAZY_POOL=false` | `agent initialized agent=0` → `agent=1` → `agent_pool_ready agents=2` → then connect |
| `LAZY_POOL=true` | connect first, no pool built |

Reproduce with:

```bash
BUZZ_PRIVATE_KEY=<nsec> BUZZ_RELAY_URL=<wss://…> \
BUZZ_ACP_AGENT_COMMAND=<…/claude-agent-acp.cmd> \
BUZZ_ACP_AGENTS=2 BUZZ_ACP_LAZY_POOL=false RUST_LOG=info \
"%LOCALAPPDATA%/Buzz/buzz-acp.exe"
```

The relay connect fails on a throwaway key — irrelevant, the pool ordering is
already decided by then.

### Effort level: measure it against the model the agent actually runs

`CLAUDE_CODE_EFFORT_LEVEL` was first measured through the local `claude` CLI,
came out as noise (12.2 s vs 12.7 s), and was removed. That inference was wrong:
the CLI runs a different model than the agent. Fabey runs **`claude-fable-5`**,
a reasoning model. Re-measured against *that*, n=3 per cell:

| fable-5 | first turn | warm turn |
| --- | --- | --- |
| default effort | 8.5 / 6.1 / 6.9 s — median **6.9 s** | 4.1 / 3.4 / 4.8 s — median **4.1 s** |
| `effort=low` | 3.5 / 3.2 / 5.3 s — median **3.5 s** | 3.9 / 6.0 / 4.4 s — median **4.4 s** |

It halves the **first** turn and does nothing for warm ones — consistent with a
reasoning model spending its budget on the opening exchange. Worth having for a
chat persona, since the first turn is the one a human waits on.

It is a genuine trade for agents doing real work: less reasoning budget is less
reasoning. Set it per-agent rather than globally if the same install runs both
chat personas and coding agents.

**Method note, learned the hard way twice in one session:** measure against the
model in production, and take three samples. Both wrong conclusions here came
from skipping one of those.

#### Verdict, 2026-08-02: removed — unconfirmed, not disproven

The key is gone from `global-agent-config.json`. The file is back to the two
settings that were verified live:

```json
{ "env_vars": { "BUZZ_ACP_AGENTS": "2", "BUZZ_ACP_LAZY_POOL": "false" } }
```

**No new samples were taken. The live evidence is still n=1.** The session that
was supposed to produce three cold samples got zero, because `buzz-acp` could
not reach the relay at all — Norton's TLS interception (above) was active, and
every agent start died at the relay connect. Four starts were attempted
(16:57:23, 16:57:39, 16:59:56, 17:00:15 UTC); all four reached
`agent_pool_ready agents=2` and then exited on
`invalid peer certificate: UnknownIssuer`. A timed-out measurement says nothing
about a config key, so nothing was inferred from it.

It was removed rather than left in place, for three reasons that hold
independently of the missing samples:

- **The one live sample is inside the noise.** 9.2 s against a 10.2 s median
  whose own three samples were 10.0 / 10.2 / 11.5 s. A 1.0 s gap on n=1 in a
  distribution that wide is not a result — and it is nowhere near the 3.4 s the
  isolation test predicted (6.9 s → 3.5 s). Those two numbers disagree, which is
  precisely why the live check mattered.
- **It was set globally, so it applied to every claude-runtime agent**, not just
  the Fabey chat persona — including any agent doing real work. This file's own
  advice was to set it per-agent for exactly that reason.
- **Less reasoning budget is less reasoning.** An unverified capability trade is
  the wrong thing to leave running by default.

Restoring it is one line in `global-agent-config.json`, and the isolation result
still stands — if the relay path is ever measurable again, this is the first
thing worth re-testing:

```json
"CLAUDE_CODE_EFFORT_LEVEL": "low"
```

#### The harness is in `fork/measure/`

It used to live in `%TEMP%`, which is not a place to keep the only means of
settling an open question. Three files, no secrets in any of them — the owner
key is read from `~/.buzz-relay-owner-key.txt` at runtime:

| File | What it does |
| --- | --- |
| `relay-probe.mjs` | NIP-98 auth + `post()` helper. Run it directly to dump channel history. |
| `time-turn-ws.mjs` | Times one turn over a NIP-42 WebSocket subscription — the transport the desktop actually receives on. Every prompt carries a token the reply must echo, so a late reply from the previous turn cannot be matched and reported as an impossible 1.6 s. |
| `cold-sample.sh` | Rewrites the config to force a fresh pool, waits for the agent to subscribe, then takes exactly one cold sample. Reports `TLS_BLOCKED` instead of a number when Norton is in the way. |

With Buzz running and the relay reachable, three samples per arm:

```bash
cd fork/measure
for m in 01 02 03; do ./cold-sample.sh A "LOW$m"; ./cold-sample.sh B "DEF$m"; done
```

Alternating the arms is deliberate — see the header comment in the script.

Untested candidates, both of which trade capability for latency and so were left
alone: `BUZZ_ACP_CONTEXT_MESSAGE_LIMIT` (12 — pre-prompt history fetched per
turn; lowering it gives the agent less conversation to work with) and
`BUZZ_ACP_NO_MEMORY` (skips `[Agent Memory — core]` injection).

**So ~9 s of the 13 s is buzz-acp and relay overhead**, against a ~3.8 s warm
model turn. That is the remaining target, and it is not reachable from
configuration.

Cross-checked against the possibility that the 13 s was an artifact of polling
`/query` (which would conflate agent latency with read-path indexing lag).
Measuring instead over a NIP-42-authed WebSocket subscription — the transport
the desktop client actually receives replies on — gives **12.9 / 13.8 / 10.2 s**,
median 12.9 s. Same answer. The latency is real, not instrumentation.

Config levers that were checked and do not exist: there is no debounce,
coalescing or settle window in the dispatch path. The only fixed delays in
`lib.rs` are a 167 ms observer publish interval and a 500 ms flush interval;
everything else on that path is timeout, retry, liveness or respawn backoff.
Closing the remaining gap means profiling the per-turn path in `buzz-acp`
(context fetch, ACP round-trips, publish) — a code change to a file upstream
owns, and therefore the one change in this fork that could conflict on a sync.

### Ruled out, with numbers

Recorded so none of these get re-litigated:

| Suspect | Verdict |
| --- | --- |
| Relay latency | 108 ms median RTT — never a factor |
| Norton TLS interception | never a turn-latency factor — but **retracted as "harmless"**: while scanning is on, `buzz-acp` cannot connect at all, so it gates whether any measurement is possible |
| `CLAUDE_CODE_EFFORT_LEVEL=low` | not settled. The 12.2 s vs 12.7 s here was measured against the wrong model and is retracted; against `fable-5` it halves the first turn in isolation but was never confirmed on the live path. Currently **unset** — see the verdict above |
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

**And `global-agent-config.json` is rewritten while the app is running** — found
on 2026-08-02, and it silently undoes edits. `CLAUDE_CODE_EFFORT_LEVEL` was
removed from the file with Buzz open; roughly three minutes later the app
flushed its in-memory copy back to disk and the key was there again, because
that copy had been loaded at launch. The same edit with Buzz closed stuck.

This does not contradict the mtime trick above — a config *write* is still what
triggers `auto_restart_on_config_change`, and the running agent does pick the
new values up. But it means a **durable** change has to be made with the app
closed, and any change made while it is open should be re-checked afterwards
rather than assumed. `python fork/tune-desktop-agents.py` says "with the app
closed" for this reason.

What *is* durable is the global env layer. `runtime.rs` writes
`BUZZ_ACP_AGENTS` from the record at line 729, then writes user `env_vars`
**last** (line 860) so they win, and `BUZZ_ACP_AGENTS` is not in
`RESERVED_ENV_KEYS` — so the global cap survives every re-seed. Put
performance limits in `global-agent-config.json`, not in per-agent records.

A proper fix (raising the default, stopping the re-seed) is a code change, and
this machine has no `cargo`/`rustc` — rebuilding the Tauri desktop app from this
fork would mean installing the Rust toolchain first.
