<#
.SYNOPSIS
    Pull the latest block/buzz changes into this fork (Saffaboy83/buzz).

.DESCRIPTION
    Fetches upstream, merges upstream/main into main, and pushes to origin.
    This is the belt-and-braces path: it uses the local `gh` credential, which
    carries the `workflow` scope, so it succeeds even when upstream has changed
    files under .github/workflows/ and the scheduled Action cannot resolve it.

    Pushing to origin/main triggers the Vercel production deploy.

.PARAMETER DryRun
    Report what would be merged without changing anything.

.EXAMPLE
    .\fork\sync-upstream.ps1
    .\fork\sync-upstream.ps1 -DryRun

.NOTES
    Never redirect git's stderr with 2>&1 here. On Windows PowerShell 5.1 that
    wraps git's ordinary progress output ("From https://...") in an ErrorRecord
    and trips $ErrorActionPreference = 'Stop'.
#>
[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$GitArgs)
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
}

# Always operate from the repo root, regardless of where this was invoked.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
Write-Host "Repo: $repoRoot" -ForegroundColor Cyan

# --- Preconditions ------------------------------------------------------------
$remotes = & git remote
if ($remotes -notcontains 'upstream') {
    Write-Host "Adding missing 'upstream' remote..." -ForegroundColor Yellow
    Invoke-Git remote add upstream https://github.com/block/buzz.git
    Invoke-Git remote set-url --push upstream DISABLED_PUSH_TO_UPSTREAM
}

$dirty = & git status --porcelain
if ($dirty) {
    Write-Host "Working tree is not clean. Commit or stash first:" -ForegroundColor Red
    $dirty | ForEach-Object { Write-Host "  $_" }
    exit 1
}

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') {
    Write-Host "Switching from '$branch' to 'main'..." -ForegroundColor Yellow
    Invoke-Git checkout main
}

# --- Fetch --------------------------------------------------------------------
Write-Host "Fetching upstream (block/buzz)..." -ForegroundColor Cyan
Invoke-Git fetch upstream main --no-tags

$behind = [int](& git rev-list --count HEAD..upstream/main).Trim()
$ahead = [int](& git rev-list --count upstream/main..HEAD).Trim()

if ($behind -eq 0) {
    Write-Host "Already up to date with upstream ($ahead fork-only commit(s))." -ForegroundColor Green
    exit 0
}

Write-Host "$behind new upstream commit(s); this fork has $ahead of its own." -ForegroundColor Cyan
Write-Host "--- incoming ---" -ForegroundColor DarkGray
& git log --oneline --no-decorate HEAD..upstream/main | Select-Object -First 25

if ($DryRun) {
    Write-Host ""
    Write-Host "[DryRun] Nothing was changed." -ForegroundColor Yellow
    exit 0
}

# --- Merge --------------------------------------------------------------------
Write-Host ""
Write-Host "Merging upstream/main..." -ForegroundColor Cyan
& git merge --no-edit upstream/main
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Merge hit conflicts. Resolve them, then run:" -ForegroundColor Red
    Write-Host "  git add -A; git commit; git push origin main" -ForegroundColor Red
    Write-Host "To abandon instead: git merge --abort" -ForegroundColor DarkGray
    exit 1
}

# --- Push ---------------------------------------------------------------------
Write-Host "Pushing to origin/main..." -ForegroundColor Cyan
Invoke-Git push origin main

$head = (& git rev-parse --short HEAD).Trim()
Write-Host ""
Write-Host "Synced. origin/main is now at $head." -ForegroundColor Green
Write-Host "Vercel builds the new commit automatically: https://vercel.com/dashboard" -ForegroundColor DarkGray
