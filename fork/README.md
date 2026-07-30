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

Vercel builds from the repo root using `/vercel.json`:

- install: `pnpm install --frozen-lockfile` (workspace root, so patches apply)
- build: `pnpm --filter buzz-web build`
- output: `web/dist`
- SPA rewrite so TanStack Router deep links resolve on refresh

Every push to `main` — whether from a sync or your own commit — redeploys.

## Two things worth knowing

**The web client needs a relay.** Buzz is self-hosted by design: the client talks
to *your* relay, and with no configuration it assumes the relay is on the same
origin it was served from. A Vercel deployment is static hosting, so the UI loads
but has no relay behind it until you set `VITE_RELAY_URL` (a build-time Vite
variable — set it in Vercel → Settings → Environment Variables, then redeploy) to
a Buzz relay's WebSocket URL, e.g. `wss://relay.example.com`.

**Upstream's CI is disabled here.** The fork inherited 12 workflows from Block —
Rust CI, Docker publishing, Helm charts, signed macOS/Windows canaries. They fire
on every push, need secrets this account doesn't have, and burn Actions minutes.
All 12 are disabled; only `Sync fork with upstream` is active. Re-enable any of
them with:

```bash
gh workflow enable "CI" --repo Saffaboy83/buzz
```
